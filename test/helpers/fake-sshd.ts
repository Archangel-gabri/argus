// Управляемый SSH-сервер в том же процессе — для отказов, которые настоящий sshd
// воспроизвести не даёт.
//
// Зачем не Docker: контейнер с OpenSSH хорош как проверка договорённости с настоящей
// реализацией, но заставить его «принять команду и никогда не закрыть поток» или
// «оборвать соединение ровно после третьего байта» нечем. Именно эти состояния и ломали
// Argus в проде, поэтому им нужен сервер, поведением которого распоряжается тест.
//
// Ключ хоста генерируется на каждый запуск: ничего постоянного на диске не появляется.
import { Server, type Connection } from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export type ExecBehaviour =
  /** Обычный ответ: напечатать текст и выйти с указанным кодом. */
  | { kind: 'reply'; stdout?: string; stderr?: string; exitCode?: number }
  /** Принять команду, что-то напечатать и НИКОГДА не закрыть поток. */
  | { kind: 'hang'; stdout?: string }
  /** Оборвать соединение, не отвечая. */
  | { kind: 'drop' }

export interface FakeSshd {
  port: number
  /** Сколько раз сервер принимал команду на выполнение. */
  execCount: () => number
  close: () => Promise<void>
}

// ssh2 разбирает традиционный RSA-PEM (PKCS#1); ed25519 в PKCS#8 он отвергает с
// «Unsupported key format». Генерация RSA стоит сотни миллисекунд, поэтому ключ делается
// один раз на прогон и переиспользуется всеми поднятыми серверами.
let hostKeyPem: string | null = null
const hostKey = (): string => {
  if (!hostKeyPem) {
    hostKeyPem = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
    }).privateKey
  }
  return hostKeyPem
}

/** Поднять сервер на случайном порту loopback. Авторизация принимает кого угодно. */
export function startFakeSshd(behaviour: ExecBehaviour): Promise<FakeSshd> {
  const privateKey = hostKey()

  let execCount = 0
  const live = new Set<Connection>()

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    live.add(client)
    client.on('error', () => {
      /* тест сам роняет соединения — это не повод падать */
    })
    client.on('close', () => live.delete(client))
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (acceptExec, _rejectExec) => {
          execCount++
          if (behaviour.kind === 'drop') {
            client.end()
            return
          }
          const stream = acceptExec()
          if (behaviour.kind === 'hang') {
            if (behaviour.stdout) stream.write(behaviour.stdout)
            // И всё. Ни exit, ни end: ровно то состояние, на котором Argus вис навсегда.
            return
          }
          if (behaviour.stdout) stream.write(behaviour.stdout)
          if (behaviour.stderr) stream.stderr.write(behaviour.stderr)
          stream.exit(behaviour.exitCode ?? 0)
          stream.end()
        })
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        execCount: () => execCount,
        close: () =>
          new Promise((done) => {
            for (const c of live) {
              try {
                c.end()
              } catch {
                /* уже закрыто */
              }
            }
            server.close(() => done())
          })
      })
    })
  })
}
