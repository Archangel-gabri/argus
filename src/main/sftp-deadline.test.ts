// Вкладка «Файлы» на почерневшем канале. Соединение живо, ответы не идут — обратный вызов не
// приходит НИКОГДА, и раньше «Загрузка…» висела до перезапуска приложения.
//
// Проверяется поведением: сессия открывается настоящим путём через поддельного клиента, потом
// список каталога молчит, а время двигается вручную.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

let destroyedSftp = 0
let destroyedClient = 0

/** Поддельный SSH-клиент: соединяется, отдаёт SFTP, который отвечает на realpath и молчит дальше. */
class FakeClient extends EventEmitter {
  sftp(cb: (err: Error | null, sftp: unknown) => void): void {
    cb(null, {
      realpath: (_p: string, done: (e: Error | null, abs: string) => void) => done(null, '/home/user'),
      readdir: () => {}, // ответа не будет никогда — это и есть «чернота»
      destroy: () => {
        destroyedSftp++
      }
    })
  }
  end(): void {}
  destroy(): void {
    destroyedClient++
  }
}

vi.mock('ssh2', () => ({ Client: FakeClient }))
vi.mock('./vault', () => ({
  getDeviceConn: () => ({ host: '198.51.100.10', port: 22, user: 'root', password: 'x', jump: null }),
  getOsEndpoints: () => []
}))
vi.mock('./ssh', () => ({
  // Соединение «удалось»: сразу сообщаем клиенту, что он готов.
  establish: (client: EventEmitter) => setTimeout(() => client.emit('ready'), 0),
  makeHostVerifier: () => () => true,
  resolveConn: () => Promise.resolve({ host: '198.51.100.10', port: 22, user: 'root', password: 'x', jump: null }),
  hasCredential: () => true,
  friendlyErr: (m: string) => m
}))
vi.mock('./access-epoch', () => ({ beginAccess: () => 1, isAccessCurrent: () => true }))

beforeEach(() => {
  destroyedSftp = 0
  destroyedClient = 0
})
afterEach(() => vi.useRealTimers())

describe('список каталога на почерневшем канале', () => {
  it('не висит вечно, отвечает отказом и обрывает сессию', async () => {
    const mod = await import('./sftp')
    const opened = await mod.sftpOpen('d1')
    expect(opened.ok).toBe(true)

    vi.useFakeTimers()
    const promise = mod.sftpList(opened.sessionId!, '/home/user')
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await promise

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/не уложилась/i)
    // Канал, который не отвечает, держать незачем: оба дескриптора закрыты.
    expect(destroyedSftp).toBe(1)
    expect(destroyedClient).toBe(1)
  })
})
