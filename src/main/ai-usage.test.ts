import { describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectUsage, localDate, parseClaudeLine, parseCodexLine, type CodexState,
  takeFresh
} from './ai-usage'
import * as vault from './vault'

// Хранилище подменяется памятью, но с ТЕМИ ЖЕ договорённостями, что у настоящего vault:
// filterUnseenUsage запоминает показанные идентификаторы, addUsageBlocks прибавляет к блоку
// по совпадению (source, startTs). Иначе тест проверял бы выдуманное хранилище, а не сбор.
vi.mock('./vault', () => {
  interface Cursor {
    path: string
    size: number
    mtime: number
    offset: number
  }
  interface Block {
    source: string
    startTs: number
    endTs: number
    tokens: number
    costUsd: number
    requests: number
  }
  const cursors = new Map<string, Cursor>()
  const seen = new Set<string>()
  const blocks = new Map<string, Block>()
  return {
    isUnlocked: (): boolean => true,
    getUsageCursor: (path: string): Cursor | null => cursors.get(path) ?? null,
    setUsageCursor: (c: Cursor): void => {
      cursors.set(c.path, c)
    },
    filterUnseenUsage: (ids: string[]): Set<string> => {
      const fresh = new Set<string>()
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        fresh.add(id)
      }
      return fresh
    },
    findAiPrice: (): null => null,
    addUsage: (): void => {},
    listUsageBlocks: (source?: string): Block[] =>
      [...blocks.values()].filter((b) => !source || b.source === source).sort((a, b) => a.startTs - b.startTs),
    addUsageBlocks: (list: Block[]): void => {
      for (const b of list) {
        const key = `${b.source}|${b.startTs}`
        const prev = blocks.get(key)
        if (!prev) {
          blocks.set(key, { ...b })
          continue
        }
        prev.tokens += b.tokens
        prev.costUsd += b.costUsd
        prev.requests += b.requests
        prev.endTs = Math.max(prev.endTs, b.endTs)
      }
    }
  }
})

// Образцы — сокращённые, но структурно точные копии реальных строк из логов на машине
// владельца. Именно на них ловятся ошибки разбора: выдуманный формат проверяет только
// собственные ожидания.

const claudeLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-30T15:50:39.343Z',
    requestId: 'req_011CdYWM2WmJkcLqWysoKUcD',
    uuid: 'ec294db2-0000-0000-0000-000000000000',
    isSidechain: false,
    message: {
      id: 'msg_011CdYWM3a1vjpfp4JYjimJY',
      model: 'claude-opus-4-7',
      usage: {
        input_tokens: 6,
        output_tokens: 217,
        cache_read_input_tokens: 33406,
        cache_creation_input_tokens: 11581,
        cache_creation: { ephemeral_5m_input_tokens: 11581, ephemeral_1h_input_tokens: 0 }
      }
    },
    ...over
  })

describe('разбор логов Claude Code', () => {
  it('вытаскивает модель, время и все четыре вида токенов', () => {
    const rec = parseClaudeLine(claudeLine())
    expect(rec).not.toBeNull()
    expect(rec?.model).toBe('claude-opus-4-7')
    expect(rec?.ts).toBe(Date.parse('2026-07-30T15:50:39.343Z'))
    expect(rec?.usage).toEqual({
      input: 6,
      output: 217,
      cacheWrite: 11581,
      cacheWrite1h: 0,
      cacheRead: 33406
    })
  })

  it('идентификатор берётся у ОТВЕТА, а не у строки', () => {
    // На живом файле владельца один ответ лежит четырьмя строками: uuid разный, message.id
    // один. Дедуп по строке не сработал бы, и расход утроился бы.
    const a = parseClaudeLine(claudeLine({ uuid: 'aaaa' }))
    const b = parseClaudeLine(claudeLine({ uuid: 'bbbb' }))
    expect(a?.id).toBe(b?.id)
    expect(a?.id).toContain('msg_011CdYWM3a1vjpfp4JYjimJY')
  })

  it('часовой кэш учитывается отдельно от пятиминутного', () => {
    const rec = parseClaudeLine(
      claudeLine({
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }
          }
        }
      })
    )
    expect(rec?.usage.cacheWrite).toBe(100)
    expect(rec?.usage.cacheWrite1h).toBe(200)
  })

  it('без разбивки кэша всё уходит в пятиминутный — ошибка в сторону занижения, а не выдумки', () => {
    const rec = parseClaudeLine(
      claudeLine({
        message: {
          id: 'msg_2',
          model: 'claude-opus-4-7',
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500 }
        }
      })
    )
    expect(rec?.usage.cacheWrite).toBe(500)
    expect(rec?.usage.cacheWrite1h).toBe(0)
  })

  it('пропускает всё, что не является ответом модели с расходом', () => {
    expect(parseClaudeLine('')).toBeNull()
    expect(parseClaudeLine('не json')).toBeNull()
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: { content: 'привет' } }))).toBeNull()
    expect(parseClaudeLine(claudeLine({ type: 'user' }))).toBeNull()
    // Синтетический ответ — локальная заглушка инструмента, денег не стоит.
    expect(
      parseClaudeLine(claudeLine({ message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 5 } } }))
    ).toBeNull()
  })

  it('отрицательные и нечисловые значения считаются нулями, а не ломают счёт', () => {
    const rec = parseClaudeLine(
      claudeLine({
        message: {
          id: 'msg_3',
          model: 'claude-opus-4-7',
          usage: { input_tokens: -5, output_tokens: 'много', cache_read_input_tokens: 10 }
        }
      })
    )
    expect(rec?.usage.input).toBe(0)
    expect(rec?.usage.output).toBe(0)
    expect(rec?.usage.cacheRead).toBe(10)
  })
})

const state = (): CodexState => ({ session: 'file', model: '', offset: 0 })

describe('разбор сессий Codex', () => {
  const meta = JSON.stringify({
    type: 'session_meta',
    payload: { session_id: '019f5c38-7e75-7771-b7f0-89cfe2d52ee2' }
  })
  const turn = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })
  const tokenCount = JSON.stringify({
    timestamp: '2026-07-30T22:08:00.154Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 103371, cached_input_tokens: 76800, output_tokens: 6175, total_tokens: 109546 },
        last_token_usage: {
          input_tokens: 23801,
          cached_input_tokens: 21248,
          cache_write_input_tokens: 0,
          output_tokens: 2604,
          reasoning_output_tokens: 87
        }
      }
    }
  })

  it('кэш вычитается из входа: у Codex он УЖЕ внутри input_tokens', () => {
    const s = state()
    parseCodexLine(meta, s)
    parseCodexLine(turn, s)
    const rec = parseCodexLine(tokenCount, s)
    // 23801 = 2553 нетронутого входа + 21248 из кэша. Иначе кэш оплачивается дважды и по
    // дорогой ставке; проверяется арифметикой самого лога (total = input + output).
    expect(rec?.usage.input).toBe(2553)
    expect(rec?.usage.cacheRead).toBe(21248)
    expect(rec?.usage.output).toBe(2604)
  })

  it('модель берётся из контекста хода, объявленного раньше расхода', () => {
    const s = state()
    parseCodexLine(turn, s)
    expect(parseCodexLine(tokenCount, s)?.model).toBe('gpt-5.5')
  })

  it('накопительный total не участвует в счёте', () => {
    const s = state()
    const rec = parseCodexLine(tokenCount, s)
    // Если бы брали total_token_usage, вышло бы 103371 входа вместо 2553 — и так на каждом
    // событии сессии, то есть квадратичное завышение.
    expect(rec?.usage.input).toBeLessThan(10_000)
  })

  it('событие без last_token_usage пропускается', () => {
    const s = state()
    const summaryOnly = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5 } } }
    })
    expect(parseCodexLine(summaryOnly, s)).toBeNull()
  })

  it('идентификатор устойчив при повторном чтении того же файла', () => {
    const first = state()
    parseCodexLine(meta, first)
    const a = parseCodexLine(tokenCount, first)
    const b = parseCodexLine(tokenCount, first)
    // Внутри одного прохода позиции разные — это разные события.
    expect(a?.id).not.toBe(b?.id)

    // А повторное чтение того же файла с нуля даёт те же идентификаторы, и дедуп их отсеет.
    const second = state()
    parseCodexLine(meta, second)
    expect(parseCodexLine(tokenCount, second)?.id).toBe(a?.id)
  })

  it('идентификатор не зависит от того, с какого места читали файл', () => {
    const bytes = (l: string): number => Buffer.byteLength(l, 'utf8') + 1
    // Проход №1 — файл с нуля: meta и turn_context в зоне видимости.
    const full = state()
    parseCodexLine(meta, full)
    parseCodexLine(turn, full)
    const a = parseCodexLine(tokenCount, full)

    // Проход №2 — дописанный хвост: meta и turn_context остались ЗА пределами чтения,
    // поэтому вызывающий передаёт байтовое смещение начала хвоста.
    const tail = { session: 'file', model: '', offset: bytes(meta) + bytes(turn) + bytes(tokenCount) }
    const b = parseCodexLine(tokenCount, tail)

    // Проход №3 — ещё один хвост. Порядковый номер здесь начинался бы с нуля и совпал бы с
    // номером прохода №2 — дедуп выбросил бы НАСТОЯЩУЮ новую запись как дубль.
    const c = parseCodexLine(tokenCount, { session: 'file', model: '', offset: tail.offset })
    expect(b?.id).not.toBe(a?.id)
    expect(c?.id).not.toBe(b?.id)
    expect(c?.id).not.toBe(a?.id)
  })

  it('хвост без turn_context честно даёт unknown, а не выдуманную модель', () => {
    // Модель объявлена в начале файла, а хвостовое чтение начинается после неё. Выдумать
    // модель — выдумать цену; unknown попадёт в unpriced и будет виден, а не оценён наугад.
    const s = { session: 'file', model: '', offset: 5000 }
    expect(parseCodexLine(tokenCount, s)?.model).toBe('unknown')
  })

  it('пустой расход не создаёт запись', () => {
    const s = state()
    const zero = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } } }
    })
    expect(parseCodexLine(zero, s)).toBeNull()
  })
})

describe('дата расхода', () => {
  it('берётся местная, а не UTC', () => {
    // Ночной час по местному времени легко уезжает на сутки назад при переводе в UTC — и
    // тогда «сегодняшний» расход попадает во вчерашний день.
    const ts = new Date(2026, 7, 3, 1, 30).getTime()
    expect(localDate(ts)).toBe('2026-08-03')
  })
})

describe('отбор записей к учёту', () => {
  const rec = (id: string): { id: string } => ({ id })

  it('копии внутри одного файла считаются ОДИН раз', () => {
    // Один ответ Claude Code лежит несколькими строками с одинаковым message.id: на живом файле
    // владельца — 11 строк на 4 ответа. Проверки «хранилище такого не видело» тут мало, она
    // пропускает все копии разом, и расход выходит кратно больше настоящего.
    const records = [rec('a'), rec('a'), rec('a'), rec('b')]
    const out = takeFresh(records, new Set(['a', 'b']))
    expect(out.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('уже учтённое хранилищем не берётся', () => {
    expect(takeFresh([rec('a'), rec('b')], new Set(['b'])).map((r) => r.id)).toEqual(['b'])
  })

  it('порядок сохраняется — блоки лимита строятся по времени', () => {
    const out = takeFresh([rec('c'), rec('a'), rec('b')], new Set(['a', 'b', 'c']))
    expect(out.map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('пустой вход не ломает', () => {
    expect(takeFresh([], new Set(['a']))).toEqual([])
  })
})

// Сбор на настоящих файлах во временном каталоге: разборщики проверены выше по одиночке, а
// оба дефекта учёта жили именно в связке «курсор + хвостовое чтение + хранилище».
describe('инкрементальный сбор', () => {
  const makeHome = (): string => mkdtempSync(join(tmpdir(), 'argus-usage-unit-'))
  const lines = (...ls: string[]): string => ls.map((l) => l + '\n').join('')

  const metaLine = JSON.stringify({
    type: 'session_meta',
    payload: { session_id: '019f5c38-0000-7771-b7f0-89cfe2d52ee2' }
  })
  const turnLine = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })
  const codexEvent = (iso: string, input: number, output: number): string =>
    JSON.stringify({
      timestamp: iso,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: output
          }
        }
      }
    })

  it('живая сессия Codex переживает три и более проходов без потерь', async () => {
    const home = makeHome()
    const dir = join(home, '.codex', 'sessions', '2026', '08', '03')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'rollout-2026-08-03T10-00-00-aaaa.jsonl')

    // Проход №1 — файл читается с начала, session_meta и модель в зоне видимости.
    writeFileSync(
      file,
      lines(metaLine, turnLine, codexEvent('2026-08-03T10:00:01Z', 100, 10), codexEvent('2026-08-03T10:00:02Z', 100, 10))
    )
    expect((await collectUsage(home)).records).toBe(2)

    // Проход №2 — дописанный хвост: session_meta за пределами чтения.
    appendFileSync(
      file,
      lines(
        codexEvent('2026-08-03T10:10:00Z', 100, 10),
        codexEvent('2026-08-03T10:10:01Z', 100, 10),
        codexEvent('2026-08-03T10:10:02Z', 100, 10)
      )
    )
    expect((await collectUsage(home)).records).toBe(3)

    // Проход №3 — ещё хвост. Порядковые номера начинались бы с нуля и совпали бы с номерами
    // прохода №2 — обе НАСТОЯЩИЕ новые записи ушли бы в дубли, и сессия недосчиталась бы.
    appendFileSync(file, lines(codexEvent('2026-08-03T10:20:00Z', 100, 10), codexEvent('2026-08-03T10:20:01Z', 100, 10)))
    const third = await collectUsage(home)
    expect(third.records).toBe(2)
    expect(third.duplicates).toBe(0)
  })

  it('окно одного источника не дробится ни по файлам, ни по проходам', async () => {
    const home = makeHome()
    const proj = join(home, '.claude', 'projects', 'p')
    mkdirSync(proj, { recursive: true })
    const answer = (iso: string, id: string, tokens: number): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: iso,
        message: { id, model: 'claude-opus-4-7', usage: { input_tokens: tokens, output_tokens: 0 } }
      }) + '\n'

    // Два разговора в одном пятичасовом окне, каждый в своём файле — окно при этом ОДНО.
    writeFileSync(join(proj, 'a.jsonl'), answer('2026-08-03T10:00:00Z', 'msg_win_a', 5_000_000))
    writeFileSync(join(proj, 'b.jsonl'), answer('2026-08-03T12:30:00Z', 'msg_win_b', 2_000_000))
    await collectUsage(home)
    const afterFirst = vault.listUsageBlocks('claude-code')
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].startTs).toBe(Date.parse('2026-08-03T10:00:00Z'))
    expect(afterFirst[0].tokens).toBe(7_000_000)

    // Следующий проход дописанного файла продолжает то же окно, а не открывает своё поверх —
    // иначе карточка «Текущая сессия» видела бы только последний осколок.
    appendFileSync(join(proj, 'b.jsonl'), answer('2026-08-03T13:40:00Z', 'msg_win_c', 1_000_000))
    await collectUsage(home)
    const afterSecond = vault.listUsageBlocks('claude-code')
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0].startTs).toBe(Date.parse('2026-08-03T10:00:00Z'))
    expect(afterSecond[0].endTs).toBe(Date.parse('2026-08-03T15:00:00Z'))
    expect(afterSecond[0].tokens).toBe(8_000_000)
  })
})
