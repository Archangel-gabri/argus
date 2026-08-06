import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  clients: [] as Array<EventEmitter & { end: ReturnType<typeof vi.fn>; forwardOut: ReturnType<typeof vi.fn> }>,
  servers: [] as Array<
    EventEmitter & {
      accept: (socket: unknown) => void
      close: ReturnType<typeof vi.fn>
      listen: ReturnType<typeof vi.fn>
    }
  >,
  listenError: null as Error | null
}))

vi.mock('ssh2', () => ({
  Client: class extends EventEmitter {
    end = vi.fn()
    forwardOut = vi.fn()

    constructor() {
      super()
      state.clients.push(this)
    }
  }
}))

vi.mock('node:net', () => ({
  createServer: vi.fn((accept: (socket: unknown) => void) => {
    const server = new EventEmitter() as EventEmitter & {
      accept: (socket: unknown) => void
      close: ReturnType<typeof vi.fn>
      listen: ReturnType<typeof vi.fn>
    }
    server.accept = accept
    server.close = vi.fn()
    server.listen = vi.fn((_port: number, _host: string, cb: () => void) => {
      if (state.listenError) throw state.listenError
      cb()
    })
    state.servers.push(server)
    return server
  })
}))

vi.mock('./ssh', () => ({
  resolveConn: vi.fn(async () => ({
    host: 'server.test',
    port: 22,
    user: 'owner',
    authType: 'password',
    password: 'not-a-real-secret'
  })),
  makeHostVerifier: vi.fn(() => vi.fn()),
  establish: vi.fn((client: EventEmitter) => queueMicrotask(() => client.emit('ready'))),
  hasCredential: vi.fn(() => true)
}))

vi.mock('./access-epoch', () => ({
  beginAccess: vi.fn(() => 1),
  isAccessCurrent: vi.fn(() => true)
}))

import { closeAllForwards, listForwards, openLocalForward } from './forward'

describe('openLocalForward — диапазоны TCP-портов', () => {
  beforeEach(() => {
    closeAllForwards()
    state.clients.length = 0
    state.servers.length = 0
    state.listenError = null
  })

  it.each([
    ['нулевой локальный', 0, 80],
    ['отрицательный локальный', -1, 80],
    ['локальный выше 65535', 65_536, 80],
    ['дробный локальный', 8080.5, 80],
    ['нулевой удалённый', 8080, 0],
    ['удалённый выше 65535', 8080, 65_536]
  ])('отклоняет %s до SSH/listen', async (_case, localPort, remotePort) => {
    const result = await openLocalForward('device-1', localPort, '127.0.0.1', remotePort)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/1.*65535/)
    expect(state.clients).toHaveLength(0)
    expect(state.servers).toHaveLength(0)
  })

  it('принимает границы 1 и 65535', async () => {
    expect((await openLocalForward('device-1', 1, '127.0.0.1', 65_535)).ok).toBe(true)
  })
})

describe('openLocalForward — жизненный цикл listener', () => {
  beforeEach(() => {
    closeAllForwards()
    state.clients.length = 0
    state.servers.length = 0
    state.listenError = null
  })

  it('обрыв SSH закрывает localhost-listener и убирает его из списка', async () => {
    const result = await openLocalForward('device-1', 8080, '127.0.0.1', 80)
    expect(result.ok).toBe(true)
    expect(listForwards('device-1')).toHaveLength(1)

    state.clients[0].emit('close')

    expect(state.servers[0].close).toHaveBeenCalledOnce()
    expect(listForwards('device-1')).toEqual([])
  })

  it('синхронный throw из listen возвращает ошибку, а не роняет main', async () => {
    state.listenError = new RangeError('bad port')

    const result = await openLocalForward('device-1', 8080, '127.0.0.1', 80)

    expect(result).toMatchObject({ ok: false, error: 'listen: bad port' })
    expect(state.clients[0].end).toHaveBeenCalledOnce()
    expect(listForwards('device-1')).toEqual([])
  })

  it('синхронный throw из forwardOut гасит сокет и мёртвый listener', async () => {
    await openLocalForward('device-1', 8080, '127.0.0.1', 80)
    state.clients[0].forwardOut.mockImplementation(() => {
      throw new Error('Not connected')
    })
    const socket = {
      destroy: vi.fn(),
      on: vi.fn(),
      pipe: vi.fn()
    }

    expect(() => state.servers[0].accept(socket)).not.toThrow()
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(state.servers[0].close).toHaveBeenCalledOnce()
    expect(listForwards('device-1')).toEqual([])
  })
})

describe('соединение через туннель на молчащем канале', () => {
  beforeEach(() => {
    closeAllForwards()
    state.clients.length = 0
    state.servers.length = 0
    state.listenError = null
  })

  it('не ждёт вечно: сокет гасится по сроку', async () => {
    // Туннель числится активным и зелёным, соединение принято, запрос канала ушёл — а ответа
    // нет. Браузер на локальном порту ждал бы бесконечно, и такие сокеты копились бы.
    await openLocalForward('device-1', 8080, '127.0.0.1', 80)
    // Ответа на запрос канала не будет никогда.
    state.clients[0].forwardOut.mockImplementation(() => {})

    const socket = { destroy: vi.fn(), destroyed: false, on: vi.fn(), pipe: vi.fn() }
    vi.useFakeTimers()
    state.servers[0].accept(socket)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(socket.destroy).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
