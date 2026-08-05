import { describe, expect, it } from 'vitest'
import { consumeSshBanner, initialStatus, nextReachability } from './reachability'

describe('трёхзначная живость', () => {
  it('новая запись без пробы начинается с «не знаю»', () => {
    expect(initialStatus(undefined)).toBe('unknown')
    expect(initialStatus('online')).toBe('online')
  })

  it('выключенной машина становится с ТРЕТЬЕГО промаха подряд', () => {
    // Двух не хватает: замер 2026-08-06 на парке владельца показал, что канал до немецкой
    // ноды теряет половину соединений даже при 15-секундном бюджете. Пара промахов подряд
    // там выпадает постоянно, и живая машина объявлялась выключенной.
    const first = nextReachability(0, 'offline')
    const second = nextReachability(first.misses, 'offline')
    const third = nextReachability(second.misses, 'offline')

    expect(first).toEqual({ status: 'unknown', misses: 1 })
    expect(second).toEqual({ status: 'unknown', misses: 2 })
    expect(third).toEqual({ status: 'offline', misses: 3 })
  })

  it('успех сбрасывает серию промахов', () => {
    expect(nextReachability(8, 'online')).toEqual({ status: 'online', misses: 0 })
  })

  it('неизмеримый jump-host не становится ни online, ни накопленным промахом', () => {
    expect(nextReachability(1, 'unknown')).toEqual({ status: 'unknown', misses: 0 })
  })
})

describe('SSH-баннер в TCP-потоке', () => {
  it('принимает баннер, разрезанный между chunks', () => {
    const first = consumeSshBanner('', 'SS')
    const second = consumeSshBanner(first.text, 'H-2.0-OpenSSH_9.9\r\n')

    expect(first.verdict).toBeNull()
    expect(second.verdict).toBe(true)
  })

  it('не путает HTTP-ответ с SSH', () => {
    expect(consumeSshBanner('', 'HTTP/1.1 200 OK\r\n').verdict).toBe(false)
  })
})
