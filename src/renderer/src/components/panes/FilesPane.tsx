import { useEffect, useState } from 'react'
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

export function FilesPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)

  // Автоскрытие тоста результата (скачано/загружено/удалено/ошибка).
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3800)
    return () => clearTimeout(t)
  }, [toast])

  const load = async (sid: string, p: string): Promise<void> => {
    if (!api) return
    setLoading(true)
    setError(null)
    const r = await api.sftp.list(sid, p)
    setLoading(false)
    if (!r.ok) {
      setError(r.error ?? 'Ошибка чтения')
      return
    }
    setPath(r.path)
    setEntries(r.entries ?? [])
  }

  useEffect(() => {
    if (!api) {
      setError('Только в десктоп-приложении.')
      return
    }
    let sid: string | null = null
    let disposed = false
    void (async () => {
      setLoading(true)
      setError(null)
      const r = await api.sftp.open(device.id)
      if (disposed) {
        // компонент размонтировался, пока открывали — не оставляем сессию в main висеть
        if (r.ok && r.sessionId && api) api.sftp.close(r.sessionId)
        return
      }
      if (!r.ok || !r.sessionId) {
        setError(r.error ?? 'Не удалось открыть SFTP')
        setLoading(false)
        return
      }
      sid = r.sessionId
      setSessionId(sid)
      await load(sid, '.')
    })()
    return () => {
      disposed = true
      if (sid && api) api.sftp.close(sid)
      setSessionId(null)
      setEntries([])
      setPath('.')
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  const enter = (e: SftpEntry): void => {
    if (sessionId && e.type === 'd') load(sessionId, joinPath(path, e.name))
  }
  const up = (): void => {
    if (sessionId) load(sessionId, path.replace(/\/[^/]+\/?$/, '') || '/')
  }
  const refresh = (): void => {
    if (sessionId) load(sessionId, path)
  }
  const download = async (e: SftpEntry): Promise<void> => {
    if (!sessionId || !api) return
    setBusy(true)
    const r = await api.sftp.download(sessionId, joinPath(path, e.name))
    setBusy(false)
    if (r.ok) setToast({ kind: 'ok', text: `Скачано: ${e.name}` })
    else if (r.error && r.error !== 'canceled') setToast({ kind: 'err', text: `Не скачалось: ${r.error}` })
  }
  const upload = async (): Promise<void> => {
    if (!sessionId || !api) return
    setBusy(true)
    const r = await api.sftp.upload(sessionId, path)
    setBusy(false)
    if (r.ok) {
      setToast({ kind: 'ok', text: `Загружено: ${r.name ?? 'файл'}` })
      refresh()
    } else if (r.error && r.error !== 'canceled') {
      setToast({ kind: 'err', text: `Не загрузилось: ${r.error}` })
    }
  }
  const remove = async (e: SftpEntry): Promise<void> => {
    if (!sessionId || !api) return
    if (!window.confirm(`Удалить «${e.name}»?`)) return
    setBusy(true)
    const r = await api.sftp.remove(sessionId, joinPath(path, e.name), e.type === 'd')
    setBusy(false)
    if (r.ok) {
      setToast({ kind: 'ok', text: `Удалено: ${e.name}` })
      refresh()
    } else {
      setToast({ kind: 'err', text: `Не удалось удалить: ${r.error ?? 'ошибка'}` })
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
          onClick={upload}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" /> Загрузить
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-6 text-center text-sm text-rose-400">{error}</div>
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
                    <button onClick={() => download(e)} className="rounded p-1 text-slate-400 hover:text-accent" title="Скачать">
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button onClick={() => remove(e)} className="rounded p-1 text-slate-400 hover:text-rose-400" title="Удалить">
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
