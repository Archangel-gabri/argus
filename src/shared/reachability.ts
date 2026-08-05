export type Reachability = 'online' | 'offline' | 'unknown'

/** Новая запись ещё не проверена; наличие адреса не является доказательством online. */
export function initialStatus<T extends string>(explicit: T | undefined): T | 'unknown' {
  return explicit ?? 'unknown'
}

/**
 * Превратить одно наблюдение канала в пользовательский статус.
 *
 * Один отрицательный замер — ещё не доказанный offline: дальние узлы реально теряют отдельные
 * рукопожатия. Но сохранять прежний online тоже нельзя, поэтому промахи копятся, и только
 * серия объявляет машину выключенной. Невозможность измерения (jump/no endpoint) промахом не
 * считается и никогда не превращается в online.
 *
 * Серия — ТРИ промаха, а не два. Замерено на парке владельца 2026-08-06: канал до немецкой
 * ноды теряет половину соединений даже при 15-секундном бюджете — то есть два промаха подряд
 * там выпадают постоянно, и машина объявлялась выключенной, продолжая работать. Это уже не про
 * бюджет ожидания, это свойство канала, и правило обязано его переживать.
 */
export function nextReachability(
  previousMisses: number,
  observation: Reachability,
  offlineAfter = 3
): { status: Reachability; misses: number } {
  if (observation === 'online') return { status: 'online', misses: 0 }
  if (observation === 'unknown') return { status: 'unknown', misses: 0 }
  const misses = previousMisses + 1
  return { status: misses >= offlineAfter ? 'offline' : 'unknown', misses }
}

export interface BannerProgress {
  text: string
  verdict: boolean | null
}

/** SSH-баннер может прийти несколькими TCP chunks (`SS` + `H-2.0...`). */
export function consumeSshBanner(previous: string, chunk: string, maxBytes = 255): BannerProgress {
  const text = (previous + chunk).slice(0, maxBytes)
  if (text.startsWith('SSH-')) return { text, verdict: true }
  if (!'SSH-'.startsWith(text)) return { text, verdict: false }
  if (text.includes('\n') || text.length >= maxBytes) return { text, verdict: false }
  return { text, verdict: null }
}
