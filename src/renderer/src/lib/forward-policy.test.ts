import { describe, expect, it } from 'vitest'
import { browserUrlForForward, forwardedRemotePorts, isForwardPort } from './forward-policy'

describe('политика UI для SSH-туннелей', () => {
  it('сопоставляет сервис по удалённому, а не локальному порту', () => {
    const ports = forwardedRemotePorts([{ localPort: 3000, remotePort: 5432 }])

    expect(ports.has(5432)).toBe(true)
    expect(ports.has(3000)).toBe(false)
  })

  it.each([
    [443, 'https://localhost:1443'],
    [2053, 'https://localhost:1443'],
    [8006, 'https://localhost:1443'],
    [3000, 'http://localhost:1443']
  ])('открывает remote %i через нужную схему', (remotePort, expected) => {
    expect(browserUrlForForward({ localPort: 1443, remotePort })).toBe(expected)
  })

  it('не притворяется браузером для не-HTTP сервиса', () => {
    expect(browserUrlForForward({ localPort: 2222, remotePort: 22 })).toBeNull()
  })

  it.each([0, -1, 65_536, 80.5, Number.NaN])('отклоняет недопустимый порт %s', (port) => {
    expect(isForwardPort(port)).toBe(false)
  })
})
