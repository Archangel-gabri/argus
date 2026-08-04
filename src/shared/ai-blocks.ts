// Окна лимита («сессии») — то, по чему провайдер отмеряет квоту подписки.
//
// У Anthropic окно длится 5 часов и начинается НЕ по часам и не в полночь, а с первого
// обращения: поработал в 14:20 — окно до 19:20. Поэтому дневных итогов для него мало, нужны
// времена ответов. Здесь из времён собираются блоки, а по блокам считается «текущая сессия».
//
// Логика чистая: main раскладывает по блокам разобранные логи, renderer показывает текущий.

export interface BlockInput {
  /** Время ответа (мс). */
  ts: number
  tokens: number
  costUsd: number
}

export interface UsageBlock {
  /** Начало окна — время первого ответа в нём. */
  startTs: number
  /** Конец окна: начало + длительность. Пересчитывать по последнему ответу нельзя — окно
   *  сдвигалось бы бесконечно, и «сброс» не наступал бы никогда. */
  endTs: number
  tokens: number
  costUsd: number
  requests: number
}

export const DEFAULT_WINDOW_HOURS = 5
const HOUR = 60 * 60 * 1000

/**
 * Разложить ответы по окнам.
 *
 * Записи сортируются: файлы читаются в произвольном порядке, а границы окон зависят от
 * последовательности. Ответ, попавший в уже открытое окно, продлевает его наполнение, но не
 * его конец.
 *
 * `existing` — окна, уже лежащие в хранилище. Запись, попавшая в такое окно, зачисляется в
 * НЕГО, а не открывает новое поверх: хранилище прибавляет к блоку по точному совпадению
 * начала, поэтому без якоря каждый файл каждого прохода заводил бы собственное окно, и
 * «текущая сессия» видела бы последний осколок вместо целого. В выдаче — только окна,
 * получившие новые записи, и только с НОВЫМИ токенами: сохранённое уже посчитано, включать
 * его сюда — задвоить при дозаписи.
 */
export function buildBlocks(
  records: BlockInput[],
  windowHours = DEFAULT_WINDOW_HOURS,
  existing: UsageBlock[] = []
): UsageBlock[] {
  const span = windowHours * HOUR
  const sorted = [...records].filter((r) => r.ts > 0).sort((a, b) => a.ts - b.ts)
  // Хронология известных окон: сохранённые (сведённые к каноническим — в хранилище могли
  // остаться перекрывающиеся осколки прежних проходов) плюс открытые этим проходом.
  const known: Array<{ startTs: number; endTs: number }> = mergeBlocks(existing).map((b) => ({
    startTs: b.startTs,
    endTs: b.endTs
  }))
  const deltas = new Map<number, UsageBlock>()
  for (const r of sorted) {
    // Самое РАННЕЕ окно, накрывающее запись: длина окна отмеряется от первого обращения,
    // поэтому при наложениях настоящим является то, что началось раньше.
    let win = known.find((w) => r.ts >= w.startTs && r.ts < w.endTs)
    if (!win) {
      win = { startTs: r.ts, endTs: r.ts + span }
      // Вставка по порядку начал: записи отсортированы, но сохранённое окно может лежать и
      // позже нового — файл со старыми временами мог впервые попасть в проход.
      const i = known.findIndex((w) => w.startTs > r.ts)
      if (i < 0) known.push(win)
      else known.splice(i, 0, win)
    }
    const d = deltas.get(win.startTs) ?? {
      startTs: win.startTs,
      endTs: win.endTs,
      tokens: 0,
      costUsd: 0,
      requests: 0
    }
    d.tokens += r.tokens
    d.costUsd += r.costUsd
    d.requests++
    deltas.set(win.startTs, d)
  }
  return [...deltas.values()].sort((a, b) => a.startTs - b.startTs)
}

/**
 * Слить перекрывающиеся окна в канонические.
 *
 * В хранилище остаются осколки прежних проходов: окно, «открытое» серединой настоящего,
 * потому что его первые записи в тот проход не попали. Осколок — то же самое окно, увиденное
 * с середины, поэтому он вливается в самое раннее накрывающее его окно: начало окна — время
 * ПЕРВОГО обращения.
 *
 * Конец при слиянии НЕ расширяется. Конец осколка отмерен от середины настоящего окна и
 * потому лжёт, а расширение склеивало бы и следующие настоящие окна: при непрерывной работе
 * цепочка не рвалась бы никогда, и «сброс» не наступал бы (см. предупреждение у endTs).
 */
export function mergeBlocks(existing: UsageBlock[], fresh: UsageBlock[] = []): UsageBlock[] {
  const sorted = [...existing, ...fresh].sort((a, b) => a.startTs - b.startTs)
  const out: UsageBlock[] = []
  for (const b of sorted) {
    const last = out[out.length - 1]
    if (last && b.startTs < last.endTs) {
      last.tokens += b.tokens
      last.costUsd += b.costUsd
      last.requests += b.requests
      continue
    }
    out.push({ ...b })
  }
  return out
}

/** Окно, которое идёт прямо сейчас. null — последнее давно закрылось.
 *  Список должен быть без перекрытий: сырые блоки из хранилища сначала через mergeBlocks. */
export function currentBlock(blocks: UsageBlock[], now = Date.now()): UsageBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (now >= b.startTs && now < b.endTs) return b
  }
  return null
}

export interface WindowState {
  block: UsageBlock
  /** Сколько миллисекунд до сброса. */
  resetsInMs: number
  /** Доля израсходованного потолка (0..1+) — null, если потолок не задан. */
  used: number | null
  /** Доля прошедшего времени окна. Показывается, когда потолок неизвестен. */
  elapsed: number
}

/**
 * Состояние текущего окна.
 *
 * `used` считается ТОЛЬКО от потолка, заданного владельцем. Anthropic свои пороги не публикует,
 * и «57 % израсходовано» без известного знаменателя было бы выдумкой — поэтому при отсутствии
 * потолка возвращается null, а интерфейс показывает абсолютный расход и время до сброса.
 */
export function windowState(
  blocks: UsageBlock[],
  limitTokens: number | null | undefined,
  now = Date.now()
): WindowState | null {
  // Сначала осколки сводятся к каноническим окнам: иначе при перекрытиях в хранилище карточка
  // показывала бы токены последнего осколка и его выдуманный срок сброса вместо целого окна.
  const block = currentBlock(mergeBlocks(blocks), now)
  if (!block) return null
  const span = block.endTs - block.startTs
  return {
    block,
    resetsInMs: Math.max(0, block.endTs - now),
    used: limitTokens && limitTokens > 0 ? block.tokens / limitTokens : null,
    elapsed: span > 0 ? Math.min(1, (now - block.startTs) / span) : 0
  }
}

/** «через 1 ч 39 мин» — так, как это читает человек, а не «5940 секунд». */
export function formatResetIn(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000))
  if (totalMin === 0) return 'вот-вот'
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `через ${m} мин`
  if (m === 0) return `через ${h} ч`
  return `через ${h} ч ${m} мин`
}
