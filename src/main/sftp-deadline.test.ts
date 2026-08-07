// Вкладка «Файлы» на почерневшем канале. Соединение живо, ответы не идут — обратный вызов не
// приходит НИКОГДА, и раньше «Загрузка…» висела до перезапуска приложения.
//
// Проверяется поведением: сессия открывается настоящим путём через поддельного клиента, потом
// список каталога молчит, а время двигается вручную.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

let destroyedSftp = 0
let destroyedClient = 0
let renamed = 0

/** Поддельный SSH-клиент: соединяется, отдаёт SFTP, который отвечает на realpath и молчит дальше. */
class FakeClient extends EventEmitter {
  sftp(cb: (err: Error | null, sftp: unknown) => void): void {
    cb(null, {
      realpath: (_p: string, done: (e: Error | null, abs: string) => void) => done(null, '/home/user'),
      readdir: () => {}, // ответа не будет никогда — это и есть «чернота»
      // Передача молчит: `step` не зовётся, кусков нет.
      fastGet: () => {},
      fastPut: () => {},
      rename: () => {
        renamed++
      },
      unlink: () => {},
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
vi.mock('electron', () => ({
  dialog: {
    // Диалог отвечает сразу: предмет проверки — что будет ПОСЛЕ выбора файла, на мёртвом канале.
    showSaveDialog: () => Promise.resolve({ canceled: false, filePath: '/tmp/argus-проверка' }),
    showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: ['/tmp/argus-исходник'] })
  },
  BrowserWindow: class {}
}))

beforeEach(() => {
  destroyedSftp = 0
  destroyedClient = 0
  renamed = 0
})
afterEach(() => vi.useRealTimers())

describe('передача файла на почерневшем канале', () => {
  it('скачивание не висит вечно и не публикует обрубок', async () => {
    // Поздний успех не имеет права переименовать `.argus-part` в имя настоящего файла: на
    // диске владельца это выглядело бы как скачанный файл, а внутри был бы огрызок.
    const mod = await import('./sftp')
    const opened = await mod.sftpOpen('d1')
    vi.useFakeTimers()
    const promise = mod.sftpDownload(opened.sessionId!, '/etc/hosts', null)
    // Срок теперь считается от последнего пришедшего куска: ждём застой, а не общее время.
    await vi.advanceTimersByTimeAsync(70_000)
    const result = await promise
    expect(result.ok).toBe(false)
    expect(renamed).toBe(0)
  })
})

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

describe('живая передача не обрывается по общему времени', () => {
  it('пока идут куски, срок не наступает', async () => {
    // Контрпример от адверсарной проверки: файл на гигабайт по каналу в мегабайт в секунду
    // идёт семнадцать минут. Абсолютный срок убил бы его на десятой минуте, хотя передача
    // исправна. Считаем от последнего куска, а не от начала.
    const transfer: { step: (() => void) | null } = { step: null }
    class MovingClient extends EventEmitter {
      connect(): void {
        setTimeout(() => this.emit('ready'), 0)
      }
      sftp(cb: (err: Error | null, sftp: unknown) => void): void {
        cb(null, {
          realpath: (_p: string, done: (e: Error | null, abs: string) => void) => done(null, '/home'),
          fastGet: (_r: string, _l: string, opts: { step: () => void }) => {
            transfer.step = opts.step // куски приходят по нашей команде
          },
          destroy: () => {}
        })
      }
      end(): void {}
      destroy(): void {}
    }

    vi.resetModules()
    vi.doMock('ssh2', () => ({ Client: MovingClient }))
    const mod = await import('./sftp')
    const opened = await mod.sftpOpen('d1')

    vi.useFakeTimers()
    let finished = false
    void mod.sftpDownload(opened.sessionId!, '/big.iso', null).then(() => {
      finished = true
    })
    // Двадцать минут передачи, куски идут каждые полминуты.
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
      transfer.step?.()
    }
    // Проверяем ИМЕННО то, ради чего правка: промис не завершился, передача жива. Прежняя
    // версия этой проверки смотрела на наличие обратного вызова — а он есть всегда, поэтому
    // проверка проходила бы и при обрыве.
    expect(finished).toBe(false)
    vi.useRealTimers()
    vi.doUnmock('ssh2')
  })
})
