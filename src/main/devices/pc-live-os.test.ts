// Какая ОС сейчас запущена на двухзагрузочной машине (находка № 38 аудита).
// Живой машины нет, поэтому сеть и SSH подставные: тест воспроизводит ровно то, что видел бы
// Argus, если бы у обеих ОС в карточке стоял один и тот же адрес.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OsEndpoint } from '../vault/vault'

const m = vi.hoisted(() => ({
  endpoints: [] as unknown[],
  uname: '' as string,
  execCalls: [] as string[]
}))

vi.mock('../vault/vault', () => ({ getOsEndpoints: () => m.endpoints, getDeviceMac: () => null }))
vi.mock('./liveness', () => ({ tcpAlive: async () => ({ status: 'online', ms: 1 }) }))
vi.mock('../remote/ssh', () => ({
  // Один физический sshd: на любое подключение к общему адресу отвечает та ОС, что загружена.
  isConnAlive: async () => true,
  execOnConn: async (_c: unknown, cmd: string) => {
    m.execCalls.push(cmd)
    return cmd === 'uname -s' ? { ok: true, output: m.uname } : { ok: true, output: '' }
  }
}))

import { whichOs } from './pc'

const ep = (os: string, host: string, port = 22, user = 'u'): OsEndpoint => ({
  os,
  conn: { host, port, user, authType: 'password', password: 'x' }
})

const LINUX = 'Linux'
const WINDOWS_ERR = "uname : The term 'uname' is not recognized as the name of a cmdlet"

let n = 0
const id = (): string => `dual-${++n}`

beforeEach(() => {
  m.execCalls = []
  m.uname = LINUX
})

describe('whichOs: эндпоинты с одним адресом', () => {
  it('загружена Windows: метка Arch (первая в списке) не побеждает', async () => {
    m.endpoints = [ep('Arch Linux', '192.168.1.50'), ep('Windows 11', '192.168.1.50')]
    m.uname = WINDOWS_ERR
    expect(await whichOs(id())).toEqual({ current: 'Windows 11', family: 'windows' })
  })

  it('загружен Linux: берётся Linux-метка, даже если она стоит второй', async () => {
    m.endpoints = [ep('Windows 11', '192.168.1.50'), ep('Arch Linux', '192.168.1.50')]
    expect(await whichOs(id())).toEqual({ current: 'Arch Linux', family: 'linux' })
  })

  it('ответ машины не разобран: ОС не угадывается по метке', async () => {
    m.endpoints = [ep('Arch Linux', '192.168.1.50'), ep('Windows 11', '192.168.1.50')]
    m.uname = 'что-то непонятное'
    expect(await whichOs(id())).toEqual({ current: '', family: 'unknown' })
  })

  it('метки нужной ОС нет: отдаётся измеренное семейство без чужой метки', async () => {
    m.endpoints = [ep('Arch Linux', '192.168.1.50'), ep('Arch (второй диск)', '192.168.1.50')]
    m.uname = WINDOWS_ERR
    expect(await whichOs(id())).toEqual({ current: 'Windows', family: 'windows' })
  })

  it('разные пользователи на одном адресе — разные подключения, ОС не спрашивается', async () => {
    m.endpoints = [ep('Arch Linux', '192.168.1.50', 22, 'vadim'), ep('Windows 11', '192.168.1.50', 22, 'Vadim')]
    expect((await whichOs(id())).family).toBeDefined()
    expect(m.execCalls).not.toContain('uname -s')
  })
})

describe('whichOs: разные адреса', () => {
  it('ОС по-прежнему берётся из метки, лишний запрос не делается', async () => {
    m.endpoints = [ep('Arch Linux', '192.168.1.50'), ep('Windows 11', '192.168.1.51')]
    const r = await whichOs(id())
    expect(['linux', 'windows']).toContain(r.family)
    expect(m.execCalls).not.toContain('uname -s')
  })
})
