// Договор с настоящим OpenSSH.
//
// Встроенный поддельный sshd нужен для отказов, которые иначе не воспроизвести. Но он написан
// нами и потому соглашается со всем, что мы делаем. Здесь поведение диктует чужая реализация:
// расхождения между тем, что мы предполагали, и тем, как ведёт себя OpenSSH, видно сразу.
//
// Отдельно проверяется схема с бастионом. Это самая дорогая по цене ошибки часть: хост за
// бастионом напрямую недостижим ПО ОПРЕДЕЛЕНИЮ, поэтому путь, забывший про jump, не «работает
// чуть хуже» — он молча объявляет живую машину мёртвой. Такое уже случалось: пока бастион был
// подключён только у терминала, метрики jump-хостов были offline навсегда.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  startSshd,
  dockerAvailable,
  createNetwork,
  connectNetwork,
  allowTcpForwarding,
  hostCanReach,
  removeNetwork,
  type SshdContainer
} from '../../test/helpers/docker-sshd'
import type { DeviceConn } from './vault'

// Настоящие known_hosts в памяти: TOFU проверяется по-честному, включая момент закрепления.
const knownHosts = new Map<string, string>()
const key = (h: string, p: number): string => `${h}:${p}`

vi.mock('./vault', () => ({
  checkHostKey: (host: string, port: number, hash: string, opts: { commit?: boolean } = {}) => {
    const seen = knownHosts.get(key(host, port))
    if (seen === undefined) {
      if (opts.commit) knownHosts.set(key(host, port), hash)
      return 'new'
    }
    return seen === hash ? 'match' : 'changed'
  },
  forgetHostKey: (host: string, port: number) => knownHosts.delete(key(host, port)),
  getDeviceConn: () => null,
  getOsEndpoints: () => [],
  listDevices: () => []
}))

const NETWORK = `argus-test-net-${process.pid}`
const available = dockerAvailable()
const run = available ? describe : describe.skip

let box: SshdContainer
let bastion: SshdContainer
let behind: SshdContainer
let behindIp = ''
let hostReachesBehind = true

const connTo = (c: SshdContainer): DeviceConn => ({
  host: '127.0.0.1',
  port: c.port,
  user: c.user,
  authType: 'password',
  password: c.password
})

beforeAll(async () => {
  if (!available) return
  // Сеть ВНУТРЕННЯЯ: только так «доступна лишь через бастион» — правда, а не слова. В обычную
  // сеть docker хост маршрутизируется напрямую, и проверка ничего бы не доказывала.
  await createNetwork(NETWORK, true)
  ;[box, bastion, behind] = await Promise.all([
    startSshd(),
    startSshd(),
    startSshd({ network: NETWORK, publish: false })
  ])
  // Бастион стоит в двух сетях: снаружи виден по опубликованному порту, внутри достаёт до
  // дальней машины. Это ровно роль бастиона.
  await connectNetwork(NETWORK, bastion.name)
  await allowTcpForwarding(bastion.name)
  behindIp = await behind.internalIp(NETWORK)
  // Предпосылку проверяем, а не предполагаем: маршрутизация docker до внутренних сетей
  // зависит от хоста, и утверждать «недостижимо» вслепую нельзя.
  hostReachesBehind = await hostCanReach(behindIp, 2222)
}, 180_000)

afterAll(() => {
  box?.stop()
  bastion?.stop()
  behind?.stop()
  removeNetwork(NETWORK)
})

run('выполнение команды против настоящего OpenSSH', () => {
  it('успешная команда отдаёт свой вывод', async () => {
    const ssh = await import('./ssh')
    const r = await ssh.execOnConn(connTo(box), 'echo argus-contract')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('argus-contract')
  })

  it('ненулевой код возврата — это отказ, а не успех', async () => {
    const ssh = await import('./ssh')
    // Раньше exec всегда рапортовал ok:true, и упавший `sudo -n reboot` считался выполненным.
    const r = await ssh.execOnConn(connTo(box), 'exit 7')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('exit 7')
  })

  it('вывод в stderr не теряется', async () => {
    const ssh = await import('./ssh')
    const r = await ssh.execOnConn(connTo(box), 'echo плохо >&2; exit 3')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('плохо')
  })

  it('неверный пароль не превращается в успех', async () => {
    const ssh = await import('./ssh')
    const r = await ssh.execOnConn({ ...connTo(box), password: 'заведомо-не-тот' }, 'echo нет')
    expect(r.ok).toBe(false)
  })
})

run('TOFU против настоящего ключа хоста', () => {
  it('ключ закрепляется ПОСЛЕ входа и потом совпадает', async () => {
    const ssh = await import('./ssh')
    const conn = connTo(box)
    knownHosts.delete(key(conn.host, conn.port))

    const first = await ssh.execOnConn(conn, 'echo первый')
    expect(first.ok).toBe(true)
    // Вход состоялся — значит ключ теперь закреплён.
    expect(knownHosts.has(key(conn.host, conn.port))).toBe(true)

    const second = await ssh.execOnConn(conn, 'echo второй')
    expect(second.ok).toBe(true)
  })

  it('неудачный вход НЕ оставляет за собой закреплённый ключ', async () => {
    const ssh = await import('./ssh')
    const conn = { ...connTo(box), password: 'заведомо-не-тот' }
    knownHosts.delete(key(conn.host, conn.port))

    await ssh.execOnConn(conn, 'echo нет')
    // Это и есть суть исправления: коннект по ошибочному адресу не должен закреплять чужой
    // ключ, иначе настоящий сервер потом читается как «ключ изменился».
    expect(knownHosts.has(key(conn.host, conn.port))).toBe(false)
  })

  it('подменённый ключ отвергается', async () => {
    const ssh = await import('./ssh')
    const conn = connTo(box)
    knownHosts.set(key(conn.host, conn.port), 'ключ-от-совсем-другой-машины')
    const r = await ssh.execOnConn(conn, 'echo не должно пройти')
    expect(r.ok).toBe(false)
    knownHosts.delete(key(conn.host, conn.port))
  })
})

run('схема с бастионом', () => {
  it('машина за бастионом напрямую недостижима — стенд честный', async ({ skip }) => {
    // На некоторых хостах docker маршрутизирует и во внутренние сети. Тогда утверждение
    // проверить нечем, и честнее пропустить, чем сделать вид, что проверили.
    if (hostReachesBehind) skip()
    const ssh = await import('./ssh')
    const direct = await ssh.execOnConn(
      { host: behindIp, port: 2222, user: behind.user, authType: 'password', password: behind.password },
      'echo напрямую',
      6000,
      8000
    )
    expect(direct.ok).toBe(false)
  })

  it('через бастион команда доходит', async () => {
    const ssh = await import('./ssh')
    const conn: DeviceConn = {
      host: behindIp,
      port: 2222,
      user: behind.user,
      authType: 'password',
      password: behind.password,
      jump: {
        host: '127.0.0.1',
        port: bastion.port,
        user: bastion.user,
        authType: 'password',
        password: bastion.password
      } as DeviceConn['jump']
    }
    const r = await ssh.execOnConn(conn, 'echo из-за-бастиона')
    expect(r.ok, `не дошло: ${r.error ?? ''} | вывод: ${r.output}`).toBe(true)
    expect(r.output).toContain('из-за-бастиона')
  })

  it('ключ БАСТИОНА тоже закрепляется — второй хоп не остаётся непроверенным', async () => {
    // Раньше jump-хоп не пинил host-key вовсе: туннель строился к кому угодно.
    expect(knownHosts.has(key('127.0.0.1', bastion.port))).toBe(true)
  })
})

if (!available) {
  describe('договор с OpenSSH', () => {
    it('пропущен: docker недоступен', () => {
      expect(available).toBe(false)
    })
  })
}
