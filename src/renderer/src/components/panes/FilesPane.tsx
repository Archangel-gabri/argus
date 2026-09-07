import { useEffect, useRef, useState } from 'react'
import {
  Folder,
  File as FileIcon,
  ArrowUp,
  Upload,
  Download,
  Trash2,
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react'
import { cn } from '@/lib/cn'
import type { DeviceDTO, SftpEntry } from '@/types'

type Toast = { kind: 'ok' | 'err'; text: string }

const api = typeof window !== 'undefined' ? window.api : undefined

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

const joinPath = (dir: string, name: string): string => dir.replace(/\/$/, '') + '/' + name
const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : 'Ошибка SFTP'

function closeSession(sid: string): void {
  try { api?.sftp.close(sid) } catch {
    // Cleanup is best-effort when preload/main has already gone away.
    console.warn('Не удалось отправить закрытие SFTP-сессии')
  }
}

export function FilesPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const session = useRef<string | null>(null)
  const generation = useRef(0)
  const opening = useRef(false)

  // Автоскрытие тоста результата (скачано/загружено/удалено/ошибка).
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3800)
    return () => clearTimeout(t)
  }, [toast])

  /**
   * Сессия мертва — её оборвали по сроку или закрыл сам сервер.
   *
   * Дальше по этой сессии всё отвечает «session closed», и вкладка остаётся мёртвой до
   * закрытия всей карточки, что заодно убивает живой терминал на соседней вкладке. Признак
   * нужен, чтобы предложить переподключиться, а не молчать.
   */
  const sessionDead = (message?: string): boolean =>
    Boolean(message && /session closed|сессия/i.test(message))

  const load = async (sid: string, p: string): Promise<void> => {
    if (!api) return
    const epoch = generation.current
    const current = (): boolean => epoch === generation.current && sid === session.current
    setLoading(true)
    setError(null)
    try {
      const r = await api.sftp.list(sid, p)
      if (!current()) return
      if (!r.ok) {
      // Срок обрывает сессию: держать её идентификатор дальше незачем, а человеку нужен путь
      // назад — кнопка переподключения вместо мёртвого «Обновить».
        if (sessionDead(r.error)) {
          closeSession(sid)
          session.current = null
          setSessionId(null)
        }
        setError(r.error ?? 'Ошибка чтения')
        return
      }
      setPath(r.path)
      setEntries(r.entries ?? [])
    } catch (cause) {
      if (current()) setError(messageOf(cause))
    } finally {
      if (epoch === generation.current) setLoading(false)
    }
  }

  /** Открыть сессию заново после обрыва — тем же путём, что и при первом входе на вкладку. */
  const connect = async (p: string): Promise<void> => {
    if (!api || opening.current) return
    const epoch = generation.current
    opening.current = true
    setLoading(true)
    setError(null)
    try {
      const r = await api.sftp.open(device.id)
      if (epoch !== generation.current) {
        if (r.ok && r.sessionId) closeSession(r.sessionId)
        return
      }
      if (!r.ok || !r.sessionId) {
        setError(r.error ?? 'Не удалось открыть файлы')
        return
      }
      if (session.current) closeSession(session.current)
      session.current = r.sessionId
      setSessionId(r.sessionId)
      await load(r.sessionId, p)
    } catch (cause) {
      if (epoch === generation.current) setError(messageOf(cause))
    } finally {
      if (epoch === generation.current) {
        opening.current = false
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!api) {
      setError('Только в десктоп-приложении.')
      return
    }
    setSessionId(null)
    setEntries([])
    setPath('.')
    setToast(null)
    setBusy(false)
    void connect('.')
    return () => {
      generation.current += 1
      opening.current = false
      if (session.current) closeSession(session.current)
      session.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  const enter = (e: SftpEntry): void => {
    if (sessionId && e.type === 'd') void load(sessionId, joinPath(path, e.name))
  }
  const up = (): void => {
    if (sessionId) void load(sessionId, path.replace(/\/[^/]+\/?$/, '') || '/')
  }
  const refresh = (): void => {
    if (sessionId) void load(sessionId, path)
  }
  const download = async (e: SftpEntry): Promise<void> => {
    if (!sessionId || !api || busy) return
    const epoch = generation.current
    setBusy(true)
    try {
      const r = await api.sftp.download(sessionId, joinPath(path, e.name))
      if (epoch !== generation.current) return
      if (r.ok) setToast({ kind: 'ok', text: `Скачано: ${e.name}` })
      else if (r.error && r.error !== 'canceled') setToast({ kind: 'err', text: `Не скачалось: ${r.error}` })
    } catch (cause) {
      if (epoch === generation.current) setToast({ kind: 'err', text: messageOf(cause) })
    } finally {
      if (epoch === generation.current) setBusy(false)
    }
  }
  const upload = async (): Promise<void> => {
    if (!sessionId || !api || busy) return
    const epoch = generation.current
    setBusy(true)
    try {
      const r = await api.sftp.upload(sessionId, path)
      if (epoch !== generation.current) return
      if (r.ok) {
        setToast({ kind: 'ok', text: `Загружено: ${r.name ?? 'файл'}` })
        refresh()
      } else if (r.error && r.error !== 'canceled') {
        setToast({ kind: 'err', text: `Не загрузилось: ${r.error}` })
      }
    } catch (cause) {
      if (epoch === generation.current) setToast({ kind: 'err', text: messageOf(cause) })
    } finally {
      if (epoch === generation.current) setBusy(false)
    }
  }
  const remove = async (e: SftpEntry): Promise<void> => {
    if (!sessionId || !api || busy) return
    if (!window.confirm(`Удалить «${e.name}»?`)) return
    const epoch = generation.current
    setBusy(true)
    try {
      const r = await api.sftp.remove(sessionId, joinPath(path, e.name), e.type === 'd')
      if (epoch !== generation.current) return
      if (r.ok) {
        setToast({ kind: 'ok', text: `Удалено: ${e.name}` })
        refresh()
      } else {
        setToast({ kind: 'err', text: `Не удалось удалить: ${r.error ?? 'ошибка'}` })
      }
    } catch (cause) {
      if (epoch === generation.current) setToast({ kind: 'err', text: messageOf(cause) })
    } finally {
      if (epoch === generation.current) setBusy(false)
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface/40">
      <div className="flex items-center gap-2 border-b border-border bg-bg/40 px-3 py-2">
        <button onClick={up} className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200" title="Вверх">
          <ArrowUp className="h-4 w-4" />
        </button>
        <button
          onClick={refresh}
          className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
          title="Обновить"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-slate-400">{path}</div>
        <button
          onClick={() => void upload()}
          disabled={busy || loading || !sessionId}
          className="flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" /> Загрузить
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-6 text-center text-sm text-rose-400">
            {error}
            {/* Обрыв сессии — не тупик: предлагаем открыть её заново прямо здесь. Раньше
                вкладка оставалась мёртвой до закрытия всей карточки, а это заодно убивало
                живой терминал на соседней вкладке. */}
            {!sessionId && (
              <div className="mt-3">
                <button
                  onClick={() => void connect(path)}
                  disabled={loading}
                  className="rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover"
                >
                  Подключиться заново
                </button>
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Загрузка…
          </div>
        ) : entries.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">Пусто.</div>
        ) : (
          <ul className="divide-y divide-border/60">
            {entries.map((e) => (
              <li key={e.name} className="group flex items-center gap-3 px-4 py-2 text-sm hover:bg-white/5">
                {e.type === 'd' ? (
                  <Folder className="h-4 w-4 shrink-0 text-accent" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0 text-slate-400" />
                )}
                <button
                  onClick={() => enter(e)}
                  disabled={e.type !== 'd'}
                  className={cn('min-w-0 flex-1 truncate text-left', e.type === 'd' ? 'text-slate-200' : 'text-slate-300')}
                >
                  {e.name}
                  {e.type === 'l' ? ' →' : ''}
                </button>
                {e.type !== 'd' && <span className="shrink-0 font-mono text-xs text-slate-500">{fmtSize(e.size)}</span>}
                <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                  {e.type === 'f' && (
                    <button onClick={() => void download(e)} disabled={busy} className="rounded p-1 text-slate-400 hover:text-accent" title="Скачать">
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button onClick={() => void remove(e)} disabled={busy} className="rounded p-1 text-slate-400 hover:text-rose-400" title="Удалить">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {toast && (
        <div
          className={cn(
            'pointer-events-none absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium shadow-lg ring-1 backdrop-blur-sm',
            toast.kind === 'ok'
              ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30'
              : 'bg-rose-500/15 text-rose-200 ring-rose-500/30'
          )}
        >
          {toast.kind === 'ok' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate">{toast.text}</span>
        </div>
      )}
    </div>
  )
}
