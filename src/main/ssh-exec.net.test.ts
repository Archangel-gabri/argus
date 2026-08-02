// Выполнение одной команды по НАСТОЯЩЕМУ ssh2 — против управляемого сервера в том же процессе.
//
// Регрессия на реальный дефект: `readyTimeout` ограничивал только рукопожатие, а после
// `client.exec` ожидание было вечным. Сервер, принявший команду и не закрывший поток,
// подвешивал промис навсегда; наверху `refreshMetrics` держит общий флаг «опрос идёт» и
// снимает его в `finally`, который в этом случае не наступал — и весь дальнейший опрос парка
// молча прекращался, а интерфейс до перезапуска показывал старые числа как свежие.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { startFakeSshd, type FakeSshd } from '../../test/helpers/fake-sshd'
import type { DeviceConn } from './vault'

// Хранилище к делу не относится: проверяется транспорт. Подменяем ровно то, что читает ssh.ts.
vi.mock('./vault', () => ({
  // Первый контакт с эфемерным сервером — ключ каждый раз новый, поэтому 'new', не 'changed'.
  checkHostKey: () => 'new',
  forgetHostKey: () => {},
  getDeviceConn: () => null,
  getOsEndpoints: () => [],
  listDevices: () => []
}))

const conn = (port: number): DeviceConn => ({
  host: '127.0.0.1',
  port,
  user: 'tester',
  authType: 'password',
  password: 'irrelevant-fake-server-accepts-anyone'
})

describe('execOnConn против управляемого sshd', () => {
  let ssh: typeof import('./ssh')
  let server: FakeSshd | null = null

  beforeAll(async () => {
    ssh = await import('./ssh')
  })

  afterEach(async () => {
    await server?.close()
    server = null
  })

  it('возвращает вывод и успех, когда команда отработала', async () => {
    server = await startFakeSshd({ kind: 'reply', stdout: 'argus-ok\n', exitCode: 0 })
    const r = await ssh.execOnConn(conn(server.port), 'echo argus-ok')
    expect(r.ok).toBe(true)
    expect(r.output).toBe('argus-ok')
  })

  it('читает РЕАЛЬНЫЙ ненулевой код возврата, а не рапортует успех', async () => {
    server = await startFakeSshd({ kind: 'reply', stdout: 'нет прав\n', exitCode: 1 })
    const r = await ssh.execOnConn(conn(server.port), 'sudo -n reboot')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('exit 1')
    // Вывод не теряется: по нему видно ПОЧЕМУ отказ.
    expect(r.output).toBe('нет прав')
  })

  it('НЕ висит вечно, если сервер принял команду и не закрыл поток', async () => {
    server = await startFakeSshd({ kind: 'hang', stdout: 'частичный вывод' })
    const started = Date.now()
    // Дедлайн выполнения передаётся явно, чтобы тест не ждал минуту.
    const r = await ssh.execOnConn(conn(server.port), 'ss -lntup', 15_000, 1_500)
    const elapsed = Date.now() - started

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/не ответила за/)
    // Уже полученное отдаём: по нему видно, докуда дошло.
    expect(r.output).toBe('частичный вывод')
    // Главное — что вернулись вообще, и примерно тогда, когда обещали.
    expect(elapsed).toBeLessThan(6_000)
    expect(server.execCount()).toBe(1)
  })

  it('обрыв соединения — это отказ, а не молчание', async () => {
    server = await startFakeSshd({ kind: 'drop' })
    const r = await ssh.execOnConn(conn(server.port), 'uptime', 15_000, 5_000)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
