export type Reachability = 'online' | 'offline' | 'unknown'

/** Новая запись ещё не проверена; наличие адреса не является доказательством online. */
export function initialStatus<T extends string>(explicit: T | undefined): T | 'unknown' {
  return explicit ?? 'unknown'
}

/**
 * Превратить одно наблюдение канала в пользовательский статус.
 *
 * Один отрицательный замер — ещё не доказанный offline: дальние узлы реально теряют отдельные
 * рукопожатия. Но сохранять прежний online тоже нельзя, поэтому первый промах становится
 * `unknown`, второй подряд — `offline`. Невозможность измерения (jump/no endpoint) не считается
 * промахом и никогда не превращается в online.
 */
export function nextReachability(
  previousMisses: number,
  observation: Reachability,
  offlineAfter = 2
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
