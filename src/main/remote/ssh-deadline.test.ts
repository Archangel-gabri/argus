// Терминал на канале, который открылся и замолчал. Рукопожатие прошло, вход состоялся, а
// ответа на запрос оболочки нет — и вкладка пульсировала «подключаюсь» до перезапуска.
//
// `readyTimeout` из ssh2 ограничивает только рукопожатие, поэтому дальше ждать было нечему.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

let destroyed = 0
let lateSessionCreated = false

class FakeClient extends EventEmitter {
  connect(): void {
    // Рукопожатие «удалось»: клиент сообщает о готовности, а дальше молчит.
    setTimeout(() => this.emit('ready'), 0)
  }
  shell(_o: unknown, _cb: (e: Error | null, s: unknown) => void): void {
    // Ответа не будет — это и есть «канал открылся и замолчал».
  }
  end(): void {}
  destroy(): void {
    destroyed++
  }
}

vi.mock('ssh2', () => ({ Client: FakeClient }))
vi.mock('../vault/vault', () => ({
  getDeviceConn: () => ({ host: '198.51.100.10', port: 22, user: 'root', password: 'x', jump: null }),
  getOsEndpoints: () => [],
  checkHostKey: () => 'match',
  forgetHostKey: () => {}
}))
vi.mock('../vault/access-epoch', () => ({ beginAccess: () => 1, isAccessCurrent: () => true }))

beforeEach(() => {
  destroyed = 0
  lateSessionCreated = false
})
afterEach(() => vi.useRealTimers())

describe('открытие терминала', () => {
  it('не висит вечно на молчащем канале и рвёт соединение', async () => {
    const mod = await import('./ssh')
    const wc = { isDestroyed: () => false, send: () => {}, once: () => { lateSessionCreated = true } }

    vi.useFakeTimers()
    const promise = mod.openShell(wc as never, 'd1', 80, 24)
    await vi.advanceTimersByTimeAsync(25_000)

    const result = await promise
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/сервер не открыл|closed/i)
    // Соединение, которое молчит, держать незачем.
    expect(destroyed).toBeGreaterThan(0)
    // Сессию терминала, о которой интерфейс не знает, заводить нельзя.
    expect(lateSessionCreated).toBe(false)
  })
})
