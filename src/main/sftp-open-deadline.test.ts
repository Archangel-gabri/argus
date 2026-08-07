// Открытие сессии файлов на канале, который замолчал после входа.
//
// Прежний ручной таймер закрывал соединение ДО того, как право завершить операцию забрано, и
// поздний ответ на запрос подсистемы всё равно клал сессию в карту: она оставалась жить, а
// закрыть её было нечем — идентификатор никому не вернули.
import { describe, expect, it, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

let deliverSftp: (() => void) | null = null
let destroyedClient = 0

class SilentSftpClient extends EventEmitter {
  connect(): void {
    setTimeout(() => this.emit('ready'), 0)
  }
  sftp(cb: (err: Error | null, sftp: unknown) => void): void {
    // Ответ придёт ПОСЛЕ срока — по нашей команде.
    deliverSftp = () => cb(null, { destroy: () => {} })
  }
  end(): void {}
  destroy(): void {
    destroyedClient++
  }
}

vi.mock('ssh2', () => ({ Client: SilentSftpClient }))
vi.mock('./vault', () => ({
  getDeviceConn: () => ({ host: '198.51.100.10', port: 22, user: 'root', password: 'x', jump: null }),
  getOsEndpoints: () => []
}))
vi.mock('./ssh', () => ({
  establish: (client: EventEmitter) => (client as unknown as { connect: () => void }).connect(),
  makeHostVerifier: () => () => true,
  resolveConn: () => Promise.resolve({ host: '198.51.100.10', port: 22, user: 'root', password: 'x', jump: null }),
  hasCredential: () => true
}))
vi.mock('./access-epoch', () => ({ beginAccess: () => 1, isAccessCurrent: () => true }))

afterEach(() => vi.useRealTimers())

describe('открытие сессии файлов', () => {
  it('поздний ответ не оставляет сессию, о которой интерфейс не знает', async () => {
    const mod = await import('./sftp')
    vi.useFakeTimers()
    const promise = mod.sftpOpen('d1')
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await promise

    expect(result.ok).toBe(false)
    expect(destroyedClient).toBeGreaterThan(0)

    // Ответ приходит поздно: сессия заводиться не должна.
    deliverSftp?.()
    expect(mod.sftpCloseDevice('d1')).toBe(0)
  })
})

describe('соединение бастиона', () => {
  it('закрывается и при обычном отказе, а не только по сроку', async () => {
    // Контрпример от адверсарной проверки: бастион успешно открыл канал, а на целевой машине
    // вход отклонён. Операция завершалась отказом, а клиент бастиона оставался жить вместе с
    // открытым на нём каналом — снаружи о нём никто не знает и закрыть нечем.
    let jumpClosed = 0
    vi.resetModules()
    vi.doMock('./ssh', () => ({
      establish: (client: { emit: (e: string, v?: unknown) => void }) => {
        // Целевая машина отвечает отказом сразу.
        setTimeout(() => client.emit('error', new Error('Authentication failed')), 0)
        return () => {
          jumpClosed++
        }
      },
      makeHostVerifier: () => () => true,
      resolveConn: () => Promise.resolve({ host: '198.51.100.10', port: 22, user: 'root', password: 'x', jump: null }),
      hasCredential: () => true
    }))
    const mod = await import('./sftp')
    const result = await mod.sftpOpen('d1')

    expect(result.ok).toBe(false)
    expect(jumpClosed).toBe(1)
    vi.doUnmock('./ssh')
  })
})
