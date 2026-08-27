import { nextReachability, type Reachability } from '../../shared/reachability'

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
const pcMetricsMisses = new Map<string, number>()
const pcOsMisses = new Map<string, number>()

/**
 * Вид проверки. У каждой своя память, и это принципиально: «выключено со второго промаха»
 * означает две неудачи ОДНОГО И ТОГО ЖЕ опроса.
 *
 * Пока `whichOs` и `pc.metrics` писали в общий счётчик, один флап канала попадал в оба — они
 * идут разными склейками и по разным поводам — и давал сразу два промаха. Машина объявлялась
 * выключенной с первой же осечки: ровно то, что правило и запрещает.
 */
export type ReachKind = 'probe' | 'pc-metrics' | 'pc-os'

const memoryFor = (kind: ReachKind): Map<string, number> =>
  kind === 'probe' ? probeMisses : kind === 'pc-metrics' ? pcMetricsMisses : pcOsMisses

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
  pcMetricsMisses.clear()
  pcOsMisses.clear()
}
