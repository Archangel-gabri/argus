import { nextReachability, type Reachability } from '../shared/reachability'

/**
 * Счётчики промахов живости — отдельно от обработчиков IPC, чтобы их можно было сбросить
 * при блокировке, не заводя круговую зависимость с модулем блокировки.
 *
 * Зачем сбрасывать: «выключено» объявляется со второго промаха подряд, потому что канал до
 * нод флапает. Счётчики жили в модульных картах и переживали lock/unlock — промах, случившийся
 * до блокировки, складывался с первым промахом после неё, и машина объявлялась выключенной,
 * хотя в новой сессии её спросили всего один раз. Это ровно та ложь о состоянии, от которой
 * правило «одна неудача = не знаю» и защищает.
 */
const probeMisses = new Map<string, number>()
const pcMisses = new Map<string, number>()

export type ReachKind = 'probe' | 'pc'

const memoryFor = (kind: ReachKind): Map<string, number> =>
  kind === 'probe' ? probeMisses : pcMisses

/** Учесть наблюдение и вернуть вердикт с поправкой на серию промахов. */
export function trackedReach(kind: ReachKind, id: string, observation: Reachability): Reachability {
  const memory = memoryFor(kind)
  const next = nextReachability(memory.get(id) ?? 0, observation)
  if (next.misses) memory.set(id, next.misses)
  else memory.delete(id)
  return next.status
}

/** Сколько промахов подряд числится за устройством — для проверок и диагностики. */
export const missesOf = (kind: ReachKind, id: string): number => memoryFor(kind).get(id) ?? 0

/** Забыть серии промахов. Новая сессия начинает считать с чистого листа. */
export function clearReachMemory(): void {
  probeMisses.clear()
  pcMisses.clear()
}
