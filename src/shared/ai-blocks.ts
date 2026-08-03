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
 */
export function buildBlocks(records: BlockInput[], windowHours = DEFAULT_WINDOW_HOURS): UsageBlock[] {
  const span = windowHours * HOUR
  const sorted = [...records].filter((r) => r.ts > 0).sort((a, b) => a.ts - b.ts)
  const out: UsageBlock[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.ts < last.endTs) {
      last.tokens += r.tokens
      last.costUsd += r.costUsd
      last.requests++
      continue
    }
    out.push({ startTs: r.ts, endTs: r.ts + span, tokens: r.tokens, costUsd: r.costUsd, requests: 1 })
  }
  return out
}

/** Слить два перекрывающихся набора блоков (новый проход логов + уже сохранённое). */
export function mergeBlocks(existing: UsageBlock[], fresh: UsageBlock[]): UsageBlock[] {
  const byStart = new Map<number, UsageBlock>()
  for (const b of existing) byStart.set(b.startTs, { ...b })
  for (const b of fresh) {
    const prev = byStart.get(b.startTs)
    if (!prev) {
      byStart.set(b.startTs, { ...b })
      continue
    }
    prev.tokens += b.tokens
    prev.costUsd += b.costUsd
    prev.requests += b.requests
  }
  return [...byStart.values()].sort((a, b) => a.startTs - b.startTs)
}

/** Окно, которое идёт прямо сейчас. null — последнее давно закрылось. */
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
  const block = currentBlock(blocks, now)
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
