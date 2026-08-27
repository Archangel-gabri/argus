// Стык двух правил, каждое из которых по отдельности уже проверено: склейка одновременных
// опросов (single-flight) и «выключено только после серии промахов подряд» (reach-memory).
//
// Регрессия на реальный дефект. Пока серию промахов считал ОБРАБОТЧИК IPC, склеенный опрос
// учитывался по разу у каждого спрашивающего. При открытой карточке по устройству независимо
// работают обновление карточки (раз в 12с) и общий проход по парку (раз в 30с); опрос длится
// секунды, окна регулярно пересекаются — и одна-единственная неудача давала сразу два промаха,
// то есть машина объявлялась выключенной с первой же осечки. Именно то, от чего правило
// «одна неудача = не знаю» защищает, и ломалось оно молча.
//
// Хранилище подменяем: настоящее тянет нативный SQLCipher, собранный под ABI Electron.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../vault/vault', () => ({
  // Устройства без доступов достаточно: probeNow отвечает отказом, не выходя в сеть, — а
  // предмет проверки здесь не сам опрос, а то, сколько раз его засчитали.
  getDeviceConn: () => null,
  getOsEndpoints: () => [],
  checkHostKey: () => 'match',
  forgetHostKey: () => {}
}))

const load = async (): Promise<{
  probe: typeof import('../remote/ssh').probe
  missesOf: typeof import('./reach-memory').missesOf
  clearReachMemory: typeof import('./reach-memory').clearReachMemory
  clearInFlight: typeof import('../support/single-flight').clearInFlight
}> => {
  const [ssh, reach, flight] = await Promise.all([
    import('../remote/ssh'),
    import('./reach-memory'),
    import('../support/single-flight')
  ])
  return {
    probe: ssh.probe,
    missesOf: reach.missesOf,
    clearReachMemory: reach.clearReachMemory,
    clearInFlight: flight.clearInFlight
  }
}

describe('опрос устройства: промах считается на наблюдение, а не на спрашивающего', () => {
  beforeEach(async () => {
    const { clearReachMemory, clearInFlight } = await load()
    clearReachMemory()
    clearInFlight()
  })

  it('два одновременных опроса — один промах и один общий вердикт «не знаю»', async () => {
    const { probe, missesOf } = await load()

    // Ровно та ситуация с открытой карточкой: два независимых потребителя спрашивают разом.
    const [a, b] = await Promise.all([probe('node-1'), probe('node-1')])

    expect(missesOf('probe', 'node-1')).toBe(1)
    expect(a.status).toBe('unknown')
    expect(b.status).toBe('unknown')
  })

  it('серия неудач ПОДРЯД по-прежнему даёт «выключено»', async () => {
    const { probe, missesOf } = await load()

    // Последовательные опросы — это разные наблюдения, и склейка их не объединяет.
    const first = await probe('node-1')
    const second = await probe('node-1')
    const third = await probe('node-1')

    expect(first.status).toBe('unknown')
    expect(second.status).toBe('unknown')
    expect(third.status).toBe('offline')
    expect(missesOf('probe', 'node-1')).toBe(3)
  })
})
