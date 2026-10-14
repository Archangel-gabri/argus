// Какая ОС сейчас запущена на двухзагрузочной машине (находка № 38 аудита).
// Живой машины нет, поэтому сеть и SSH подставные, но устроены как настоящая машина: одна
// запущенная ОС, у неё свой пользователь; чужой пользователь войти не может; `uname` на Windows
// отвечает «не распознано». Тест воспроизводит то, что видел бы Argus при одинаковом адресе у двух ОС.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { OsEndpoint } from '../vault/vault'

interface Call {
  user: string
  cmd: string
}

interface State {
  endpoints: unknown[]
  /** Что загружено; null — машина выключена. */
  booted: 'linux' | 'windows' | null
  /** Хосты, на которых машина сейчас отвечает; null — все. */
  upHosts: string[] | null
  /** Пользователь, которого пускает запущенная ОС; null — пускает любого (одинаковая учётка). */
  users: { linux: string | null; windows: string | null }
  uname: 'normal' | 'timeout' | 'garbage'
  calls: { user: string; cmd: string }[]
  /** Неудачные входы: машина ответила, но не пустила пользователя (за них sshd штрафует адрес). */
  denied: number
}

const m = vi.hoisted(
  (): State => ({
    endpoints: [],
    booted: 'linux',
    upHosts: null,
    users: { linux: 'linux-user', windows: 'windows-user' },
    uname: 'normal',
    calls: [],
    denied: 0
  })
)

vi.mock('../vault/vault', () => ({ getOsEndpoints: () => m.endpoints, getDeviceMac: () => null }))
vi.mock('./liveness', () => ({ tcpAlive: async () => ({ status: 'online', ms: 1 }) }))
vi.mock('../remote/ssh', () => {
  const DENIED = { ok: false, output: '', error: 'All configured authentication methods failed' }
  const DOWN = { ok: false, output: '', error: 'connect ECONNREFUSED' }
  /** null — вошли; иначе ответ отказа. Отказ во входе считается: это и есть «неудачный вход». */
  const login = (c: { host: string; user: string }): typeof DENIED | null => {
    if (!m.booted) return DOWN
    if (m.upHosts && !m.upHosts.includes(c.host)) return DOWN
    const allowed = m.users[m.booted]
    if (allowed === null || allowed === c.user) return null
    m.denied++
    return DENIED
  }
  return {
    isConnAlive: async (c: { host: string; user: string }) => login(c) === null,
    execOnConn: async (c: { host: string; user: string }, cmd: string) => {
      m.calls.push({ user: c.user, cmd })
      const refused = login(c)
      if (refused) return refused
      if (cmd === 'echo argus-ok') return { ok: true, output: 'argus-ok' }
      if (cmd === 'uname -s') {
        if (m.uname === 'timeout') return { ok: false, output: '', error: 'команда не ответила за 8с' }
        if (m.uname === 'garbage') return { ok: true, output: 'что-то непонятное' }
        return m.booted === 'linux'
          ? { ok: true, output: 'Linux' }
          : { ok: false, output: "uname : The term 'uname' is not recognized as the name of a cmdlet", error: 'exit 1' }
      }
      return { ok: true, output: '' }
    }
  }
})

import { whichOs, bootEntries, metrics, powerDiag } from './pc'

const ep = (os: string, host: string, user: string, port = 22): OsEndpoint => ({
  os,
  conn: { host, port, user, authType: 'password', password: 'x' }
})
const calls = (): Call[] => m.calls
const unames = (): number => calls().filter((c) => c.cmd === 'uname -s').length
/** Рабочие команды — всё, кроме проб входа и ОС. */
const work = (): Call[] => calls().filter((c) => c.cmd !== 'uname -s' && c.cmd !== 'echo argus-ok')

let n = 0
const id = (): string => `dual-${++n}`

const ARCH = 'Arch Linux'
const WIN = 'Windows 11'
const ADDR = '192.168.1.50'
const polls = async (deviceId: string, k = 3): Promise<{ current: string; family: string }[]> => {
  const out: { current: string; family: string }[] = []
  for (let i = 0; i < k; i++) out.push(await whichOs(deviceId))
  return out
}

beforeEach(() => {
  m.calls = []
  m.booted = 'linux'
  m.upHosts = null
  m.users = { linux: 'linux-user', windows: 'windows-user' }
  m.uname = 'normal'
  m.denied = 0
})

describe('whichOs: общий адрес, одна учётная запись', () => {
  beforeEach(() => {
    m.users = { linux: null, windows: null } // пускают любого: логин ничего не различает
  })

  it('загружена Windows: метка Arch (первая в списке) не побеждает', async () => {
    m.endpoints = [ep(ARCH, ADDR, 'u'), ep(WIN, ADDR, 'u')]
    m.booted = 'windows'
    expect(await whichOs(id())).toEqual({ current: WIN, family: 'windows' })
  })

  it('загружен Linux: берётся Linux-метка, даже если она стоит второй', async () => {
    m.endpoints = [ep(WIN, ADDR, 'u'), ep(ARCH, ADDR, 'u')]
    expect(await whichOs(id())).toEqual({ current: ARCH, family: 'linux' })
  })

  it('ответ машины не разобран: ОС не угадывается по метке', async () => {
    m.endpoints = [ep(ARCH, ADDR, 'u'), ep(WIN, ADDR, 'u')]
    m.uname = 'garbage'
    expect(await whichOs(id())).toEqual({ current: '', family: 'unknown' })
  })

  it('метки нужной ОС нет: отдаётся измеренное семейство без чужой метки', async () => {
    m.endpoints = [ep(ARCH, ADDR, 'u'), ep('Arch (второй диск)', ADDR, 'u')]
    m.booted = 'windows'
    expect(await whichOs(id())).toEqual({ current: 'Windows', family: 'windows' })
  })
})

describe('whichOs: общий адрес, у ОС разные пользователи (находка № 38, контрпример 1)', () => {
  const pair = (): OsEndpoint[] => [ep(ARCH, ADDR, 'linux-user'), ep(WIN, ADDR, 'windows-user')]

  it('загружена Windows: три опроса подряд дают Windows, ОС спрашивается у машины', async () => {
    m.endpoints = pair()
    m.booted = 'windows'
    const deviceId = id()
    expect(await polls(deviceId)).toEqual(Array(3).fill({ current: WIN, family: 'windows' }))
    expect(unames()).toBeGreaterThan(0)
  })

  it('загружен Linux: три опроса дают Arch', async () => {
    m.endpoints = pair()
    expect(await polls(id())).toEqual(Array(3).fill({ current: ARCH, family: 'linux' }))
  })

  it('порядок меток не важен: Windows-эндпоинт первым, загружен Linux', async () => {
    m.endpoints = pair().reverse()
    expect(await polls(id())).toEqual(Array(3).fill({ current: ARCH, family: 'linux' }))
  })

  it('машина выключена: off', async () => {
    m.endpoints = pair()
    m.booted = null
    const r = await polls(id())
    expect(r.at(-1)).toEqual({ current: '', family: 'off' })
    expect(r.every((x) => x.family !== 'linux' && x.family !== 'windows')).toBe(true)
  })

  // Первый вариант — чужой пользователь войти не может; второй — обе учётные записи пускают
  // (одинаковый пароль), и различает ОС только ответ самой машины.
  it.each([
    ['чужой пользователь не входит', { linux: 'linux-user', windows: 'windows-user' }],
    ['пускают обоих', { linux: null, windows: null }]
  ] as const)('bootEntries идёт под учётной записью живой ОС, а не другой (%s)', async (_n, users) => {
    m.endpoints = pair()
    m.booted = 'windows'
    m.users = { ...users }
    const r = await bootEntries(id())
    expect(r.os).toBe(WIN)
    const cmds = work()
    expect(cmds.length).toBeGreaterThan(0)
    // Ни одна рабочая команда не ушла под Linux-пользователем, и это не efibootmgr.
    expect(cmds.every((c) => c.user === 'windows-user')).toBe(true)
    expect(cmds.some((c) => c.cmd.includes('efibootmgr'))).toBe(false)
  })

  it('пускают обоих, загружена Windows: три опроса дают Windows (не метку первого эндпоинта)', async () => {
    m.endpoints = pair()
    m.booted = 'windows'
    m.users = { linux: null, windows: null }
    expect(await polls(id())).toEqual(Array(3).fill({ current: WIN, family: 'windows' }))
  })

  it('bootEntries при загруженном Linux идёт под Linux-пользователем', async () => {
    m.endpoints = pair().reverse()
    await bootEntries(id())
    const cmds = work()
    expect(cmds.length).toBeGreaterThan(0)
    expect(cmds.every((c) => c.user === 'linux-user' && c.cmd.includes('efibootmgr'))).toBe(true)
  })
})

describe('whichOs: машина жива, ОС не определена (контрпример 2)', () => {
  it.each(['timeout', 'garbage'] as const)('uname: %s — три опроса дают unknown, не off', async (mode) => {
    m.endpoints = [ep(ARCH, ADDR, 'linux-user'), ep(WIN, ADDR, 'windows-user')]
    m.uname = mode
    expect(await polls(id())).toEqual(Array(3).fill({ current: '', family: 'unknown' }))
  })

  it('bootEntries на неопределённой ОС не шлёт команд наугад', async () => {
    m.endpoints = [ep(ARCH, ADDR, 'linux-user'), ep(WIN, ADDR, 'windows-user')]
    m.uname = 'timeout'
    const r = await bootEntries(id())
    expect(r.ok).toBe(false)
    expect(work()).toEqual([])
  })
})

describe('whichOs: кэш не отдаёт прошлую ОС после перезагрузки', () => {
  it('безымянные эндпоинты на одном адресе: Linux, затем Windows', async () => {
    m.endpoints = [ep('', ADDR, 'linux-user'), ep('', ADDR, 'windows-user')]
    const deviceId = id()
    expect(await whichOs(deviceId)).toEqual({ current: 'Linux', family: 'linux' })
    m.booted = 'windows'
    expect(await whichOs(deviceId)).toEqual({ current: 'Windows', family: 'windows' })
    m.booted = 'linux'
    expect(await whichOs(deviceId)).toEqual({ current: 'Linux', family: 'linux' })
  })
})

describe('whichOs: прежнее поведение', () => {
  it('разные адреса: живой тот, где машина отвечает, лишний uname не нужен', async () => {
    m.endpoints = [ep(ARCH, ADDR, 'linux-user'), ep(WIN, '192.168.1.51', 'windows-user')]
    m.booted = 'windows'
    m.upHosts = ['192.168.1.51']
    expect(await polls(id())).toEqual(Array(3).fill({ current: WIN, family: 'windows' }))
    expect(unames()).toBe(0)
  })

  it('один эндпоинт с меткой: ОС из метки, uname не вызывается', async () => {
    m.endpoints = [ep(WIN, ADDR, 'windows-user')]
    m.booted = 'windows'
    expect(await whichOs(id())).toEqual({ current: WIN, family: 'windows' })
    expect(unames()).toBe(0)
  })

  it('бастион: адреса разные, ОС из метки без uname', async () => {
    const jump = { host: 'bastion', port: 22, user: 'j', authType: 'password' as const, password: 'x' }
    const withJump = (e: OsEndpoint): OsEndpoint => ({ ...e, conn: { ...e.conn, jump } })
    m.endpoints = [withJump(ep(ARCH, ADDR, 'linux-user')), withJump(ep(WIN, '192.168.1.51', 'windows-user'))]
    m.booted = 'windows'
    m.upHosts = ['192.168.1.51']
    expect(await whichOs(id())).toEqual({ current: WIN, family: 'windows' })
    expect(unames()).toBe(0)
  })

  it('бастион и общий адрес с разными пользователями: ОС всё равно спрашивается у машины', async () => {
    const jump = { host: 'bastion', port: 22, user: 'j', authType: 'password' as const, password: 'x' }
    const withJump = (e: OsEndpoint): OsEndpoint => ({ ...e, conn: { ...e.conn, jump } })
    m.endpoints = [withJump(ep(ARCH, ADDR, 'linux-user')), withJump(ep(WIN, ADDR, 'windows-user'))]
    m.booted = 'windows'
    expect(await whichOs(id())).toEqual({ current: WIN, family: 'windows' })
  })
})


// Штрафы OpenSSH (PerSourcePenalties, 9.8+): каждый неудачный вход — 5 с штрафа адресу источника,
// при 15 с sshd сбрасывает все его подключения. Вкладка «Метрики» опрашивает ПК раз в ~3 с, и вход
// «под всеми учётками сразу» копил штраф быстрее, чем он сгорает (docs/audit/2026-10-14-n38-ssh-penalties.md).
describe('общий адрес: неудачных входов нет в устойчивом состоянии (штрафы sshd)', () => {
  // Свой адрес на тест: память «под кем вошли» живёт по host:port весь процесс.
  let a = 0
  const pairAt = (): OsEndpoint[] => {
    const host = `10.38.0.${++a}`
    return [ep(ARCH, host, 'linux-user'), ep(WIN, host, 'windows-user')]
  }
  const cycles = async (deviceId: string, k: number): Promise<string[]> => {
    const out: string[] = []
    for (let i = 0; i < k; i++) out.push((await metrics(deviceId)).family)
    return out
  }

  it.each(['linux', 'windows'] as const)('загружена %s: 20 циклов «Метрик» — ноль неудачных входов', async (os) => {
    m.endpoints = pairAt()
    m.booted = os
    const deviceId = id()
    await metrics(deviceId) // первый опрос ещё не знает, с кого начать
    m.denied = 0
    expect(await cycles(deviceId, 20)).toEqual(Array(20).fill(os))
    expect(m.denied).toBe(0)
  })

  it('перезагрузка в другую ОС стоит ровно одного неудачного входа', async () => {
    const pair = pairAt()
    m.endpoints = pair
    const deviceId = id()
    expect(await whichOs(deviceId)).toEqual({ current: ARCH, family: 'linux' })
    m.booted = 'windows'
    m.denied = 0
    expect(await whichOs(deviceId)).toEqual({ current: WIN, family: 'windows' })
    expect(m.denied).toBe(1)
    expect(await cycles(deviceId, 20)).toEqual(Array(20).fill('windows'))
    expect(m.denied).toBe(1)
    m.booted = 'linux'
    expect(await whichOs(deviceId)).toEqual({ current: ARCH, family: 'linux' })
    expect(m.denied).toBe(2)
  })

  it('пускают обоих: после перезагрузки берётся метка запущенной ОС, а не запомненного эндпоинта', async () => {
    m.endpoints = pairAt()
    m.users = { linux: null, windows: null }
    const deviceId = id()
    expect(await whichOs(deviceId)).toEqual({ current: ARCH, family: 'linux' })
    m.booted = 'windows'
    expect(await polls(deviceId)).toEqual(Array(3).fill({ current: WIN, family: 'windows' }))
    expect(m.denied).toBe(0)
  })

  it('ОС не определилась: unknown, а не off, и чужую учётку не перебираем', async () => {
    m.endpoints = pairAt()
    const deviceId = id()
    await whichOs(deviceId)
    m.denied = 0
    m.uname = 'garbage'
    expect(await polls(deviceId, 5)).toEqual(Array(5).fill({ current: '', family: 'unknown' }))
    expect(m.denied).toBe(0)
  })

  it('ОС не определилась с первого опроса: unknown, дальше без неудачных входов', async () => {
    m.endpoints = pairAt()
    m.uname = 'timeout'
    const deviceId = id()
    expect(await polls(deviceId, 5)).toEqual(Array(5).fill({ current: '', family: 'unknown' }))
    expect(m.denied).toBe(1) // только первый опрос, пока не знали, чья учётка входит
  })

  it('машина выключена: off, по адресу стучится только запомненный эндпоинт', async () => {
    m.endpoints = pairAt()
    const deviceId = id()
    await whichOs(deviceId)
    m.booted = null
    m.calls = []
    const r = await polls(deviceId)
    expect(r.at(-1)).toEqual({ current: '', family: 'off' })
    expect(calls().every((c) => c.user === 'linux-user')).toBe(true)
    expect(calls()).toHaveLength(3)
  })

  describe('повторы питания и диагностики', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })
    const diag = async (deviceId: string): Promise<string> => {
      const p = powerDiag(deviceId)
      await vi.runAllTimersAsync()
      return (await p).text
    }

    it('три попытки на неопределённой ОС не дают трёх неудачных входов', async () => {
      m.endpoints = pairAt()
      m.uname = 'timeout'
      expect(await diag(id())).toMatch(/не определена/)
      expect(m.denied).toBe(1) // первая попытка без памяти; две следующие — только своя учётка
    })

    it('ОС ответила: диагностика идёт под её учёткой без чужих входов', async () => {
      m.endpoints = pairAt()
      m.booted = 'windows'
      const deviceId = id()
      await whichOs(deviceId)
      m.denied = 0
      m.calls = []
      await diag(deviceId)
      expect(m.denied).toBe(0)
      expect(calls().every((c) => c.user === 'windows-user')).toBe(true)
    })
  })
})
