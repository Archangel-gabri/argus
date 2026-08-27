import { Client, type SFTPWrapper } from 'ssh2'
import { randomUUID } from 'node:crypto'
import { dialog, type BrowserWindow } from 'electron'
import { rename, rm } from 'node:fs'
import { resolveConn, makeHostVerifier, establish, hasCredential } from './ssh'
import { beginAccess, isAccessCurrent } from '../vault/access-epoch'
import { withDeadline } from '../../shared/deadline'

/** Понятные тексты вместо сырых ssh2-ошибок (частые причины «Файлы не работают»). */
function friendlyErr(msg: string): string {
  if (/channel open failure|subsystem|sftp/i.test(msg))
    return 'SFTP-подсистема недоступна на сервере (проверь `Subsystem sftp` в sshd_config)'
  if (/permission denied|EACCES/i.test(msg)) return 'Нет прав (permission denied)'
  if (/no such file|ENOENT/i.test(msg)) return 'Путь не существует / нет доступа к каталогу'
  if (/host key/i.test(msg)) return 'Ключ хоста изменился — открой Terminal и подтверди новый ключ'
  return msg
}

interface SftpSession {
  id: string
  /** Чьё это соединение. Нужно, чтобы удаление устройства могло его закрыть. */
  deviceId: string
  client: Client
  sftp: SFTPWrapper
}
const sessions = new Map<string, SftpSession>()

export interface SftpEntry {
  name: string
  type: 'd' | 'f' | 'l'
  size: number
  mtime: number
}

export async function sftpOpen(deviceId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const accessTicket = beginAccess()
  const conn = await resolveConn(deviceId)
  if (!isAccessCurrent(accessTicket)) return { ok: false, error: 'Argus заблокирован' }
  if (!conn) return Promise.resolve({ ok: false, error: 'Device not found' })
  if (!conn.host || conn.host.includes('x.x')) return Promise.resolve({ ok: false, error: 'Placeholder IP — set a real host first.' })
  if (!hasCredential(conn)) return Promise.resolve({ ok: false, error: 'No SSH credential stored (password or key).' })
  const client = new Client()
  const id = randomUUID()
  let sftpRef: SFTPWrapper | null = null

  // Ручной таймер здесь был, но отменял источник в НЕВЕРНОМ порядке: соединение закрывалось до
  // того, как право завершить операцию забрано, и сообщение о сроке подменялось сообщением о
  // закрытии. Хуже другое: поздний ответ на запрос SFTP всё равно клал сессию в карту — она
  // оставалась жить, а интерфейс о ней не знал и закрыть не мог.
  // Отмена соединения включает клиента бастиона, если подключаемся через него.
  let disposeConn: (() => void) | null = null
  return withDeadline<{ ok: boolean; sessionId?: string; error?: string }>({
    ms: SFTP_OPEN_MS,
    what: 'сервер не открыл доступ к файлам',
    dispose: () => {
      try {
        disposeConn?.()
      } catch {
        /* соединение могло умереть раньше */
      }
      try {
        sftpRef?.destroy()
      } catch {
        /* дескриптор мог не появиться вовсе */
      }
      try {
        client.destroy()
      } catch {
        /* соединение могло умереть раньше */
      }
    },
    run: (gate) => {
      // То же и здесь: неудачный исход обязан закрыть соединение бастиона. По сроку оно
      // закрывалось, а по обычному отказу — нет.
      const done = (r: { ok: boolean; sessionId?: string; error?: string }): void => {
        const won = gate.settle(() => r)
        if (won && !r.ok) disposeConn?.()
      }

      client.on('ready', () => {
        if (!isAccessCurrent(accessTicket)) {
          client.end()
          done({ ok: false, error: 'Argus заблокирован' })
          return
        }
        client.sftp((err, sftp) => {
          if (err) {
            done({ ok: false, error: friendlyErr(err.message) })
            client.end()
            return
          }
          sftpRef = sftp
          if (!isAccessCurrent(accessTicket)) {
            client.end()
            done({ ok: false, error: 'Argus заблокирован' })
            return
          }
          // Сессия попадает в карту ТОЛЬКО если ждать ещё есть кому. Поздний ответ иначе
          // оставлял бы живую сессию, о которой интерфейс не знает.
          const registered = gate.settle(
            () => {
              sessions.set(id, { id, deviceId, client, sftp })
              client.on('close', () => sessions.delete(id)) // не течь сессией при обрыве
              return { ok: true, sessionId: id }
            },
            () => {
              try {
                sftp.destroy()
              } catch {
                /* уже мёртв */
              }
              client.end()
            }
          )
          void registered
        })
      })
      client.on('error', (e) => done({ ok: false, error: friendlyErr(e.message) }))
      // Канал закрылся ДО открытия SFTP — почти всегда выключенный/запрещённый sftp-subsystem.
      client.on('close', () => {
        if (gate.active()) {
          done({ ok: false, error: 'Соединение закрылось до открытия SFTP (проверь SFTP-subsystem на сервере)' })
        }
      })
      // Через jump-бастион если задан — иначе Файлы не открывались у jump-хостов.
      disposeConn = establish(client, conn, makeHostVerifier(conn.host, conn.port), (e) =>
        done({ ok: false, error: e.message })
      )
    }
  }).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'SFTP не открылся'
  }))
}

/**
 * Оборвать сессию целиком: канал почернел, и держать её незачем.
 *
 * Идемпотентна — срок может сработать одновременно с закрытием сессии руками.
 */
function abortSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  try {
    s.sftp.destroy()
  } catch {
    /* дескриптор мог умереть раньше */
  }
  try {
    s.client.destroy()
  } catch {
    /* то же */
  }
}

/** Сколько ждём короткую операцию над файлами. Список каталога дольше этого не идёт никогда. */
const SFTP_META_MS = 20_000
/** Сколько ждём открытие сессии: рукопожатие, вход и ответ на запрос подсистемы SFTP. */
const SFTP_OPEN_MS = 20_000
/**
 * Сколько ждём БЕЗ ДВИЖЕНИЯ при передаче файла.
 *
 * Срок здесь считается не от начала, а от последнего пришедшего куска. Абсолютный не годится:
 * файл на гигабайт по каналу в мегабайт в секунду идёт семнадцать минут, и любой разумный
 * общий срок убил бы живую передачу на середине. Зато канал, замолчавший на минуту при живом
 * соединении, мёртв независимо от размера файла.
 *
 * `fastGet`/`fastPut` сообщают о каждом куске через `step` — по нему и продлеваем.
 */
const SFTP_STALL_MS = 60_000

/**
 * Часы для сроков — монотонные, а не настенные.
 *
 * `Date.now()` прыгает: перевод системного времени вперёд на две минуты заставил бы сторож
 * застоя оборвать исправную передачу, а перевод назад — не заметить настоящий застой, пока
 * часы не догонят прежнее значение. `performance.now()` идёт равномерно и назад не ходит.
 */
const monotonic = (): number => performance.now()
/**
 * Последний рубеж для передачи: столько она не идёт ни при каких обстоятельствах.
 *
 * Нужен только чтобы промис не жил вечно, если сломается сам сторож застоя. Реальное решение
 * принимает застой: общий срок в разумные минуты убил бы исправную передачу большого файла —
 * ровно та ошибка, ради исправления которой застой и вводился.
 */
const SFTP_TRANSFER_CEILING_MS = 24 * 60 * 60 * 1000

export function sftpList(
  sessionId: string,
  path: string
): Promise<{ ok: boolean; path: string; entries?: SftpEntry[]; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.resolve({ ok: false, path, error: 'сессия файлов оборвана' })
  const p = path || '.'
  type Result = { ok: boolean; path: string; entries?: SftpEntry[]; error?: string }
  // Канал может «почернеть»: соединение живо, а ответы не идут. Тогда ни один из двух
  // обратных вызовов не придёт никогда, и вкладка «Файлы» остаётся в «Загрузка…» до
  // перезапуска приложения. Срок обрывает сессию и отвечает честно.
  return withDeadline<Result>({
    ms: SFTP_META_MS,
    what: 'сервер не прислал список файлов',
    dispose: () => abortSession(sessionId),
    run: (gate) => {
      s.sftp.realpath(p, (rerr, abs) => {
        // Первый ответ мог прийти вовремя, а срок истечь до второго: вторую фазу запускаем,
        // только если ждать ещё есть кому.
        if (!gate.active()) return
        const dir = rerr ? p : abs
        s.sftp.readdir(dir, (err, list) => {
          if (err) {
            gate.reject(new Error(friendlyErr(err.message)))
            return
          }
          const entries: SftpEntry[] = list
            .map((e) => ({
              name: e.filename,
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- без него тернарник выводится как string
              type: (e.longname.startsWith('d') ? 'd' : e.longname.startsWith('l') ? 'l' : 'f') as SftpEntry['type'],
              size: e.attrs.size,
              mtime: e.attrs.mtime
            }))
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1))
          gate.settle(() => ({ ok: true, path: dir, entries }))
        })
      })
    }
  }).catch((error: unknown) => ({
    ok: false,
    path,
    error: error instanceof Error ? error.message : 'не удалось прочитать каталог'
  }))
}

export async function sftpDownload(
  sessionId: string,
  remotePath: string,
  win: BrowserWindow | null
): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return { ok: false, error: 'сессия файлов оборвана' }
  const base = remotePath.split('/').pop() || 'download'
  // parent-окно ОБЯЗАТЕЛЬНО: на KDE Wayland диалог без родителя открывается позади окна/без фокуса
  // → «нажал Скачать, ничего не произошло».
  const res = win
    ? await dialog.showSaveDialog(win, { defaultPath: base })
    : await dialog.showSaveDialog({ defaultPath: base })
  if (res.canceled || !res.filePath) return { ok: false, error: 'canceled' }
  const target = res.filePath
  // Качаем в соседний временный файл и публикуем переименованием.
  //
  // `fastGet` открывает назначение на запись СРАЗУ и усекает его до нуля. Скачивая свежую
  // копию поверх старой, владелец терял старую в первую же секунду: обрыв канала на середине
  // (а канал до нод флапает) оставлял на её месте обрубок, и восстановить было неоткуда.
  const tmp = `${target}.argus-part`
  type Result = { ok: boolean; error?: string }
  let lastMove = monotonic()
  return withDeadline<Result>({
    // Здесь именно ПОТОЛОК: `withDeadline` умеет только общий срок, а решение о живости
    // принимает сторож застоя ниже. Поставить сюда рабочий предел значило бы вернуть ту самую
    // ошибку — обрыв исправной передачи большого файла на середине.
    ms: SFTP_TRANSFER_CEILING_MS,
    dispose: () => {
      abortSession(sessionId)
      // Обрубок на своём диске убираем: он носит имя файла владельца с приставкой и легко
      // принимается за скачанное.
      rm(tmp, { force: true }, () => {})
    },
    run: (gate) => {
      const stall = setInterval(() => {
        if (monotonic() - lastMove < SFTP_STALL_MS) return
        clearInterval(stall)
        abortSession(sessionId)
        rm(tmp, { force: true }, () => {})
        gate.reject(new Error(`передача встала: за ${SFTP_STALL_MS / 1000} с не пришло ни одного куска`))
      }, 5_000)
      ;(stall as unknown as { unref?: () => void }).unref?.()
      s.sftp.fastGet(remotePath, tmp, { step: () => (lastMove = monotonic()) }, (err) => {
        clearInterval(stall)
        if (err) {
          rm(tmp, { force: true }, () => gate.reject(new Error(friendlyErr(err.message))))
          return
        }
        // Публикуем переименованием только если ждать ещё есть кому: поздний успех не имеет
        // права положить обрубок под именем настоящего файла.
        if (!gate.active()) {
          rm(tmp, { force: true }, () => {})
          return
        }
        rename(tmp, target, (e) => {
          if (e) {
            gate.reject(new Error(`файл скачан, но не переименован: ${e.message}`))
            return
          }
          gate.settle(() => ({ ok: true }))
        })
      })
    }
  }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'не скачалось' }))
}

export async function sftpUpload(
  sessionId: string,
  remoteDir: string,
  win: BrowserWindow | null
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return { ok: false, error: 'сессия файлов оборвана' }
  const res = win
    ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
    : await dialog.showOpenDialog({ properties: ['openFile'] })
  if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'canceled' }
  const local = res.filePaths[0]
  const name = local.split('/').pop() || 'file'
  const remote = remoteDir.replace(/\/$/, '') + '/' + name
  // То же самое в обратную сторону: заливаем во временное имя, публикуем переименованием.
  // Иначе прерванная загрузка (в том числе блокировкой приложения, которая рвёт SSH) заменяет
  // рабочий файл на сервере обрубком — а это уже чужая машина, и чинить придётся руками.
  const tmpRemote = `${remote}.argus-part`
  type Result = { ok: boolean; name?: string; error?: string }
  let lastMove = monotonic()
  return withDeadline<Result>({
    ms: SFTP_TRANSFER_CEILING_MS,
    what: 'файл так и не загрузился',
    // Обрубок на ЧУЖОЙ машине убрать уже нечем: канал мёртв, и попытка удаления повисла бы так
    // же. Он остаётся под именем с приставкой `.argus-part` — по нему видно, что это огрызок.
    dispose: () => abortSession(sessionId),
    run: (gate) => {
      const stall = setInterval(() => {
        if (monotonic() - lastMove < SFTP_STALL_MS) return
        clearInterval(stall)
        abortSession(sessionId)
        gate.reject(new Error(`передача встала: за ${SFTP_STALL_MS / 1000} с не ушло ни одного куска`))
      }, 5_000)
      ;(stall as unknown as { unref?: () => void }).unref?.()
      s.sftp.fastPut(local, tmpRemote, { step: () => (lastMove = monotonic()) }, (err) => {
        clearInterval(stall)
        if (err) {
          s.sftp.unlink(tmpRemote, () => gate.reject(new Error(friendlyErr(err.message))))
          return
        }
        // Поздний успех не имеет права опубликовать огрызок под конечным именем: на сервере
        // владельца это заменило бы рабочий файл обрубком.
        if (!gate.active()) return
        s.sftp.rename(tmpRemote, remote, (e2) => {
          if (e2) {
            gate.reject(new Error(friendlyErr(e2.message)))
            return
          }
          gate.settle(() => ({ ok: true, name }))
        })
      })
    }
  }).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'не загрузилось' }))
}

/** Программная заливка файла (без диалога выбора) — нужна провижинингу агента. */
export function sftpPutFile(
  sessionId: string,
  localPath: string,
  remotePath: string
): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.resolve({ ok: false, error: 'сессия файлов оборвана' })
  let lastMove = monotonic()
  return withDeadline<{ ok: boolean; error?: string }>({
    ms: SFTP_TRANSFER_CEILING_MS,
    what: 'агент так и не залился',
    dispose: () => abortSession(sessionId),
    run: (gate) => {
      const stall = setInterval(() => {
        if (monotonic() - lastMove < SFTP_STALL_MS) return
        clearInterval(stall)
        abortSession(sessionId)
        gate.reject(new Error('заливка встала: канал не принимает данные'))
      }, 5_000)
      ;(stall as unknown as { unref?: () => void }).unref?.()
      s.sftp.fastPut(localPath, remotePath, { step: () => (lastMove = monotonic()) }, (err) => {
        clearInterval(stall)
        if (err) {
          gate.reject(new Error(friendlyErr(err.message)))
          return
        }
        gate.settle(() => ({ ok: true }))
      })
    }
  }).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'файл не залился'
  }))
}

/** Записать небольшой секрет напрямую по SFTP. В отличие от `ssh exec "printf <secret>"`,
 * содержимое не попадает в argv удалённого shell, историю PowerShell и process listing. */
export function sftpWriteFile(
  sessionId: string,
  remotePath: string,
  content: string,
  mode = 0o600
): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.resolve({ ok: false, error: 'сессия файлов оборвана' })
  return withDeadline<{ ok: boolean; error?: string }>({
    ms: SFTP_META_MS,
    what: 'сервер не записал файл',
    dispose: () => abortSession(sessionId),
    run: (gate) => {
      s.sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), { mode }, (err) => {
        if (err) {
          gate.reject(new Error(friendlyErr(err.message)))
          return
        }
        gate.settle(() => ({ ok: true }))
      })
    }
    // Повторять запись секрета после срока НЕЛЬЗЯ автоматически: мы не знаем, дошла ли она.
    // Вторая попытка могла бы положить на машину второй токен, о котором никто не знает.
  }).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'файл не записался'
  }))
}

export function sftpDelete(sessionId: string, path: string, isDir: boolean): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.resolve({ ok: false, error: 'сессия файлов оборвана' })
  return withDeadline<{ ok: boolean; error?: string }>({
    ms: SFTP_META_MS,
    what: 'сервер не удалил файл',
    dispose: () => abortSession(sessionId),
    run: (gate) => {
      const cb = (err: Error | null | undefined): void => {
        if (err) {
          gate.reject(new Error(err.message))
          return
        }
        gate.settle(() => ({ ok: true }))
      }
      if (isDir) s.sftp.rmdir(path, cb)
      else s.sftp.unlink(path, cb)
    }
  }).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'не удалилось'
  }))
}

export function sftpClose(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (s) {
    try {
      s.client.end()
    } catch {
      /* ignore */
    }
    sessions.delete(sessionId)
  }
}

export function sftpCloseAll(): void {
  for (const id of [...sessions.keys()]) sftpClose(id)
}

/** Закрыть файловые сессии ОДНОГО устройства. Возвращает, сколько закрыл. */
export function sftpCloseDevice(deviceId: string): number {
  const ids = [...sessions.values()].filter((s) => s.deviceId === deviceId).map((s) => s.id)
  for (const id of ids) sftpClose(id)
  return ids.length
}
