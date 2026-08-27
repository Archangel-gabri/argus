// Живой расход: сколько токенов и денег ушло на самом деле.
//
// Данные берутся из ЛОКАЛЬНЫХ логов инструментов — Argus никуда не ходит и ничего не отправляет.
// Причина простая: спросить провайдера не у кого. Anthropic и OpenAI не отдают spend по обычному
// ключу (только по Admin-ключу организации), а подписки Claude Max и ChatGPT Plus не отдают его
// вовсе. Зато оба инструмента подробно пишут расход себе в файлы.
//
// Четыре вещи, без которых счёт врёт (каждая закрыта проверкой):
//
// 1. ОДИН ОТВЕТ ЛЕЖИТ В ФАЙЛЕ НЕСКОЛЬКО РАЗ. В логах Claude Code запись ответа повторяется
//    при ветвлении разговора: одинаковые message.id и usage, разные uuid. На живом файле
//    владельца — 11 записей на 4 настоящих ответа. Наивная сумма завышает расход втрое.
// 2. У CODEX `total_token_usage` НАКОПИТЕЛЬНЫЙ за сессию. Сложить его по всем событиям —
//    получить квадрат. Считаем по `last_token_usage`.
// 3. У CODEX `input_tokens` УЖЕ ВКЛЮЧАЕТ кэш, а `output_tokens` — размышления. Проверяется
//    арифметикой самого лога: total_tokens = input_tokens + output_tokens. Значит нетронутый
//    вход = input − cached, иначе кэш посчитается дважды и по дорогой ставке.
// 4. ЧЕТЫРЕ СТАВКИ, НЕ ОДНА. Чтение кэша дешевле входа в 10 раз, запись — дороже. См. ai-pricing.
//
// Проход инкрементальный: на каждый файл хранится курсор (размер + mtime + смещение), и второй
// запуск не перечитывает 300 файлов заново. Всё, что зависит от места старта чтения, обязано
// это переживать: идентификаторы событий Codex строятся от байтового смещения в файле, а окна
// лимита раскладываются с учётом уже сохранённых блоков.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZERO_USAGE, addUsage, costOf, totalTokens, type TokenUsage } from '../../shared/ai-pricing'
import { DEFAULT_WINDOW_HOURS, buildBlocks, type BlockInput } from '../../shared/ai-blocks'
import type { AiUsageDay } from '../types'
import * as vault from '../vault/vault'

/** Один учтённый ответ модели. */
export interface UsageRecord {
  /** Устойчивый идентификатор для дедупа между файлами и между запусками. */
  id: string
  /** Время ответа (мс). */
  ts: number
  model: string
  usage: TokenUsage
}

/** Что осталось от файла Codex между строками: модель и сессия объявлены раньше расхода. */
export interface CodexState {
  session: string
  model: string
  /** Байтовое смещение ТЕКУЩЕЙ строки от начала файла (не хвоста); двигает сам разборщик.
   *  Из него собирается идентификатор события: порядковый номер при чтении хвоста начинался
   *  бы с нуля каждый проход и повторял бы номера прошлого прохода. */
  offset: number
}

// --- Разбор строк (чистые функции, зовутся из проверок напрямую) ---------------------------

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * Строка лога Claude Code (`~/.claude/projects/**\/*.jsonl`).
 * Возвращает null для всего, что не является ответом модели с расходом.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  if (!line.trim()) return null
  let d: {
    type?: string
    timestamp?: string
    requestId?: string
    message?: { id?: string; model?: string; usage?: ClaudeUsage }
  }
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  if (d.type !== 'assistant') return null
  const msg = d.message
  const u = msg?.usage
  if (!u || !msg?.model) return null
  // Синтетические ответы (локальные заглушки инструмента) денег не стоят и модели не имеют.
  if (msg.model.includes('synthetic')) return null

  // Идентификатор ответа, а не строки: uuid у дублей разный, а message.id — один и тот же.
  const id = msg.id || d.requestId
  if (!id) return null

  // Разбивка кэша на 5-минутный и часовой появилась не сразу. Если её нет — вся запись кэша
  // считается пятиминутной: это дешевле часовой, то есть ошибка в безопасную сторону, а не
  // выдуманная переплата.
  const c5 = u.cache_creation?.ephemeral_5m_input_tokens
  const c1h = n(u.cache_creation?.ephemeral_1h_input_tokens)
  const cacheWrite = c5 != null ? n(c5) : n(u.cache_creation_input_tokens)

  return {
    id: `cc:${id}`,
    ts: Date.parse(d.timestamp || '') || 0,
    model: msg.model,
    usage: {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheWrite,
      cacheWrite1h: c1h,
      cacheRead: n(u.cache_read_input_tokens)
    }
  }
}

interface CodexLine {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    session_id?: string
    model?: string
    info?: {
      last_token_usage?: {
        input_tokens?: number
        cached_input_tokens?: number
        cache_write_input_tokens?: number
        output_tokens?: number
      }
    }
  }
}

/**
 * Строка сессии Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * Мутирует `state`: модель и идентификатор сессии объявляются раньше событий расхода.
 */
export function parseCodexLine(line: string, state: CodexState): UsageRecord | null {
  // Позиция строки запоминается ДО любых выходов: смещение обязана продвинуть КАЖДАЯ строка,
  // включая пустые и нечитаемые, иначе позиции всех последующих строк съедут.
  const at = state.offset
  state.offset += Buffer.byteLength(line, 'utf8') + 1
  if (!line.trim()) return null
  let d: CodexLine
  try {
    d = JSON.parse(line)
  } catch {
    return null
  }
  const p = d.payload
  if (!p) return null

  if (d.type === 'session_meta' && p.session_id) state.session = p.session_id
  // Модель объявляется в контексте хода и может смениться посреди сессии.
  if (d.type === 'turn_context' && p.model) state.model = p.model
  if (d.type !== 'event_msg' || p.type !== 'token_count') return null

  const last = p.info?.last_token_usage
  // Событие без последнего расхода — это сводка при завершении; в ней только накопительный
  // итог, который складывать нельзя.
  if (!last) return null

  const inputTotal = n(last.input_tokens)
  const cached = n(last.cached_input_tokens)
  const out = n(last.output_tokens)
  if (inputTotal + out === 0) return null

  return {
    // Байтовое смещение события в файле: своего идентификатора у события нет, а смещение —
    // единственный признак, не зависящий от места старта чтения. Порядковый номер при чтении
    // хвоста начинался бы с нуля каждый проход, повторял бы номера прошлого прохода — и
    // filterUnseenUsage выбрасывал бы настоящие новые записи как дубли. При повторном чтении
    // с нуля смещения совпадут, и дедуп по-прежнему отсеет уже учтённое.
    id: `codex:${state.session}:${at}`,
    ts: Date.parse(d.timestamp || '') || 0,
    // Хвостовое чтение может начаться ПОСЛЕ turn_context — тогда модель честно неизвестна:
    // токены посчитаются под именем «unknown» и попадут в unpriced, а не оценятся по
    // выдуманной цене. Тянуть модель из прошлого прохода некуда: курсор vault хранит только
    // позицию файла (расширение его схемы — отдельное решение, не отсюда).
    model: state.model || 'unknown',
    usage: {
      // Кэш уже сидит внутри input_tokens — вычитаем, иначе он оплачивается дважды.
      input: Math.max(0, inputTotal - cached),
      // Размышления уже внутри output_tokens (проверяется равенством total = input + output).
      output: out,
      cacheWrite: n(last.cache_write_input_tokens),
      cacheWrite1h: 0,
      cacheRead: cached
    }
  }
}

// --- Обход файлов ---------------------------------------------------------------------------

/** Локальная дата yyyy-mm-dd: расход смотрят по своим суткам, а не по UTC. */
export function localDate(ts: number): string {
  const d = new Date(ts)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function walk(dir: string, match: (name: string) => boolean, out: string[] = []): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Каталога может не быть вовсе (инструмент не установлен) или в него может не пускать
    // права — и то, и другое означает «расхода отсюда нет», а не поломку.
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, match, out)
    else if (e.isFile() && match(e.name)) out.push(p)
  }
  return out
}

/**
 * Прочитать НОВЫЙ хвост файла построчно.
 *
 * Смещение двигается только до последнего полного перевода строки: файл может быть открыт на
 * запись, и хвост без `\n` — это половина записи. Учесть её сейчас и ещё раз в следующий
 * проход значило бы посчитать один ответ дважды.
 *
 * Работаем с байтами, а не с символами: в логах есть русский текст, и позиция в символах не
 * совпадает с позицией в файле.
 */
async function readTail(path: string, from: number): Promise<{ lines: string[]; consumed: number }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const stream = createReadStream(path, { start: from })
    stream.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    stream.on('error', reject)
    stream.on('end', () => {
      const buf = Buffer.concat(chunks)
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl < 0) return resolve({ lines: [], consumed: 0 })
      const complete = buf.subarray(0, lastNl)
      resolve({ lines: complete.toString('utf8').split('\n'), consumed: lastNl + 1 })
    })
  })
}

export interface CollectResult {
  /** Сколько файлов реально пришлось читать (у остальных не изменился размер и время). */
  files: number
  /** Сколько новых ответов учтено. */
  records: number
  /** Сколько отброшено как уже учтённые. */
  duplicates: number
  /** Модели, для которых в каталоге нет цены: их токены посчитаны, а деньги — нет. */
  unpriced: string[]
}

interface Source {
  name: string
  root: string
  match: (file: string) => boolean
  parse: (line: string, state: CodexState) => UsageRecord | null
}

function sources(home: string): Source[] {
  return [
    {
      name: 'claude-code',
      root: join(home, '.claude', 'projects'),
      match: (f) => f.endsWith('.jsonl'),
      parse: (line) => parseClaudeLine(line)
    },
    {
      name: 'codex',
      root: join(home, '.codex', 'sessions'),
      match: (f) => f.startsWith('rollout-') && f.endsWith('.jsonl'),
      parse: (line, state) => parseCodexLine(line, state)
    }
  ]
}

/**
 * Пройти по логам и добавить новое к дневным итогам.
 *
 * Хранилище должно быть открыто: и курсоры, и итоги живут в зашифрованной базе.
 */
/**
 * Оставить записи, которые надо учесть: невиданные хранилищем И не повторяющиеся между собой.
 *
 * Второе условие — не придирка. Один ответ Claude Code лежит в логе несколькими строками с
 * одинаковым `message.id` (на живом файле владельца — 11 строк на 4 ответа). Хранилище отвечает
 * лишь «этот идентификатор мне незнаком», и если проверять только это, все копии пройдут разом:
 * расход выйдет кратно больше настоящего, а счётчик «отброшено» при этом отрапортует, что дубли
 * убраны. Дедуп между запусками работал, внутри одного файла — нет.
 */
export function takeFresh<T extends { id: string }>(records: T[], fresh: Set<string>): T[] {
  const taken = new Set<string>()
  const out: T[] = []
  for (const rec of records) {
    if (!fresh.has(rec.id) || taken.has(rec.id)) continue
    taken.add(rec.id)
    out.push(rec)
  }
  return out
}

export async function collectUsage(home = homedir()): Promise<CollectResult> {
  const result: CollectResult = { files: 0, records: 0, duplicates: 0, unpriced: [] }
  if (!vault.isUnlocked()) return result

  const unpriced = new Set<string>()
  // Цены спрашиваем у базы один раз на модель: findAiPrice — это запрос, а моделей в проходе
  // единицы, зато записей тысячи.
  const rateCache = new Map<string, ReturnType<typeof vault.findAiPrice>>()

  for (const src of sources(home)) {
    if (!existsSync(src.root)) continue
    const files = await walk(src.root, src.match)
    // Ответы для окон лимита копятся по ИСТОЧНИКУ, а не по файлу: окно у инструмента общее,
    // и два разговора из разных файлов обязаны попасть в одно окно, а не в два перекрывающихся.
    const srcRecords: BlockInput[] = []
    for (const path of files) {
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      const cursor = vault.getUsageCursor(path)
      const mtime = Math.floor(stat.mtimeMs)
      if (cursor && cursor.size === stat.size && cursor.mtime === mtime) continue
      // Файл усечён или переписан — прежнее смещение указывает в середину чужой записи.
      const from = cursor && stat.size >= cursor.size ? cursor.offset : 0

      const { lines, consumed } = await readTail(path, from)
      result.files++
      if (!consumed) {
        vault.setUsageCursor({ path, size: stat.size, mtime, offset: from })
        continue
      }

      // session_meta лежит в начале файла и при чтении хвоста не встретится — тогда роль
      // сессии играет путь. Для дедупа это безвредно: смещения хвоста не пересекаются с уже
      // прочитанными, а при повторном чтении с нуля meta снова попадёт в проход.
      const state: CodexState = { session: path, model: '', offset: from }
      const records: UsageRecord[] = []
      for (const line of lines) {
        const rec = src.parse(line, state)
        if (rec) records.push(rec)
      }

      if (records.length) {
        // Пометка «учтено», дневные итоги и курсор кладутся ОДНОЙ транзакцией.
        //
        // filterUnseenUsage не фильтрует, а помечает: он вставляет идентификаторы в свою
        // таблицу и коммитит. Пока итоги писались отдельно и позже, падение между этими шагами
        // (заперта база, кончился диск) означало, что ответы уже помечены учтёнными, а расход
        // по ним не записан — и следующий проход выбрасывал их как дубли. Потеря молчаливая:
        // счётчик дублей при этом честно показывает, что всё в порядке.
        const applied = vault.atomically(() => {
          const usable = takeFresh(records, vault.filterUnseenUsage(records.map((r) => r.id)))
          const pending: BlockInput[] = []
          // Сначала складываем по (день, модель), потом считаем деньги: цена одна на группу.
          const buckets = new Map<string, { date: string; model: string; usage: TokenUsage; requests: number }>()
          for (const rec of usable) {
            const date = localDate(rec.ts || stat.mtimeMs)
            const key = `${date}|${rec.model}`
            const b = buckets.get(key) ?? { date, model: rec.model, usage: { ...ZERO_USAGE }, requests: 0 }
            b.usage = addUsage(b.usage, rec.usage)
            b.requests++
            buckets.set(key, b)
            if (!rateCache.has(rec.model)) rateCache.set(rec.model, vault.findAiPrice(rec.model))
            const p = rateCache.get(rec.model) ?? null
            // Отдельно копятся сами ответы: окна лимита живут не сутками, а часами от первого
            // обращения, и по дневным итогам их не восстановить. Копятся ЛОКАЛЬНО: при откате
            // транзакции они не должны осесть в общем списке — окна посчитались бы по расходу,
            // которого в базе нет.
            pending.push({
              ts: rec.ts || stat.mtimeMs,
              tokens: totalTokens(rec.usage),
              costUsd: p
                ? costOf(rec.usage, {
                    input: p.input,
                    output: p.output,
                    cacheWrite: p.cacheWrite,
                    cacheWrite1h: p.cacheWrite1h,
                    cacheRead: p.cacheRead
                  })
                : 0
            })
          }

          const days: AiUsageDay[] = []
          const missing: string[] = []
          for (const b of buckets.values()) {
            if (!rateCache.has(b.model)) rateCache.set(b.model, vault.findAiPrice(b.model))
            const price = rateCache.get(b.model) ?? null
            if (!price) missing.push(b.model)
            const cost = price
              ? costOf(b.usage, {
                  input: price.input,
                  output: price.output,
                  cacheWrite: price.cacheWrite,
                  cacheWrite1h: price.cacheWrite1h,
                  cacheRead: price.cacheRead
                })
              : 0
            days.push({
              date: b.date,
              source: src.name,
              model: b.model,
              input: b.usage.input,
              output: b.usage.output,
              cacheWrite: b.usage.cacheWrite,
              cacheWrite1h: b.usage.cacheWrite1h,
              cacheRead: b.usage.cacheRead,
              requests: b.requests,
              costUsd: cost
            })
          }
          if (days.length) vault.addUsage(days)
          // Курсор двигается внутри той же транзакции: «прочитано» и «учтено» обязаны
          // фиксироваться вместе, иначе их снова можно рассогласовать.
          vault.setUsageCursor({ path, size: stat.size, mtime, offset: from + consumed })
          return { pending, missing, duplicates: records.length - usable.length }
        })

        srcRecords.push(...applied.pending)
        result.records += applied.pending.length
        result.duplicates += applied.duplicates
        for (const model of applied.missing) unpriced.add(model)
      } else {
        vault.setUsageCursor({ path, size: stat.size, mtime, offset: from + consumed })
      }
    }

    if (srcRecords.length) {
      // Раскладка по окнам идёт с оглядкой на уже сохранённые блоки: запись, попавшая в окно
      // прошлого прохода, продолжает его — buildBlocks выдаст дельту с ЕГО началом, и
      // хранилище прибавит к своему блоку по совпадению начала. Без этого каждый проход
      // открывал бы окно заново, и «текущая сессия» видела бы последний осколок.
      const blocks = buildBlocks(srcRecords, DEFAULT_WINDOW_HOURS, vault.listUsageBlocks(src.name))
      if (blocks.length) {
        vault.addUsageBlocks(
          blocks.map((b) => ({
            source: src.name,
            startTs: b.startTs,
            endTs: b.endTs,
            tokens: b.tokens,
            costUsd: b.costUsd,
            requests: b.requests
          }))
        )
      }
    }
  }

  result.unpriced = [...unpriced]
  return result
}
