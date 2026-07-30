import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { DeviceDTO } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

type ConnStatus = 'connecting' | 'connected' | 'closed' | 'error'

const PILL: Record<ConnStatus, { dot: string; text: string; label: string }> = {
  connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400', label: 'подключаюсь' },
  connected: { dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'на связи' },
  closed: { dot: 'bg-slate-500', text: 'text-slate-400', label: 'закрыт' },
  error: { dot: 'bg-rose-500', text: 'text-rose-400', label: 'ошибка' }
}

export function TerminalPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  // Отдельно от errMsg: полоса про ключ хоста показывается по тексту errMsg, и запись
  // туда ошибки самого доверия схлопнула бы полосу вместе с кнопкой.
  const [trustErr, setTrustErr] = useState<string | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    setErrMsg(null)
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#0e0d0c',
        foreground: '#d6d3d1',
        cursor: '#f59e0b',
        selectionBackground: 'rgba(245,158,11,0.25)'
      }
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon())
    searchRef.current = search
    term.open(hostRef.current)
    fit.fit()
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* webgl unavailable → canvas fallback */
    }
    term.focus()

    let sessionId: string | null = null
    let offData: (() => void) | null = null
    let offExit: (() => void) | null = null
    let disposed = false

    if (!api) {
      setStatus('error')
      term.writeln('\x1b[31m✖ Терминал работает только в приложении.\x1b[0m')
    } else {
      void (async () => {
        const r = await api.ssh.open(device.id, term.cols, term.rows)
        if (disposed) return
        if (!r.ok || !r.sessionId) {
          setStatus('error')
          setErrMsg(r.error ?? 'Не удалось подключиться')
          term.writeln(`\x1b[31m✖ ${r.error ?? 'Не удалось подключиться'}\x1b[0m`)
          return
        }
        sessionId = r.sessionId
        setStatus('connected')
        offData = api.ssh.onData((p) => {
          if (p.sessionId === sessionId) term.write(b64ToBytes(p.data))
        })
        offExit = api.ssh.onExit((p) => {
          if (p.sessionId === sessionId) {
            term.writeln('\r\n\x1b[33m— session closed —\x1b[0m')
            setStatus('closed')
          }
        })
        // Подписки готовы — просим main слить буфер первых байт (приглашение/баннер).
        api.ssh.attach(sessionId)
        term.onData((d) => {
          if (sessionId) api.ssh.input(sessionId, d)
        })
      })()
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (sessionId && api) api.ssh.resize(sessionId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
    })
    ro.observe(hostRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      offData?.()
      offExit?.()
      if (sessionId && api) api.ssh.close(sessionId)
      term.dispose()
    }
  }, [device.id, retry])

  // Снятие закрепления делает main по ТОМУ адресу, к которому реально пойдёт подключение.
  // Здесь адрес брать нельзя: у многозагрузочной машины живая ОС может сидеть на другом
  // адресе и порту, и мы бы забыли чужой ключ, а ошибка осталась бы на месте.
  const trustNewKey = async (): Promise<void> => {
    if (!api) return
    setTrustErr(null)
    const r = await api.ssh.trustDeviceKey(device.id)
    if (!r.ok) {
      setTrustErr(r.error ?? 'не удалось снять закрепление ключа')
      return
    }
    setErrMsg(null)
    setStatus('connecting')
    setRetry((n) => n + 1)
  }

  const pill = PILL[status]
  const hostKeyChanged = /host key changed/i.test(errMsg ?? '')

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-[#0e0d0c]">
      <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-2">
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full', pill.dot)} />
          <span className={cn('text-[11px] font-medium', pill.text)}>{pill.label}</span>
        </span>
        <input
          placeholder="поиск (Enter)…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') searchRef.current?.findNext(e.currentTarget.value)
          }}
          className="w-32 rounded-md border border-border bg-bg/60 px-2 py-1 text-xs text-slate-200 outline-none transition-all focus:w-44 focus:border-accent/40"
        />
      </div>
      {hostKeyChanged && (
        <div className="flex items-center gap-3 border-b border-rose-500/30 bg-rose-500/10 px-3 py-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
          <span className="min-w-0 flex-1 text-xs text-rose-200">
            Ключ хоста изменился — возможен MITM. Доверяйте только если сервер переустанавливали/меняли ключ.
            {trustErr && <span className="mt-0.5 block text-rose-300/80">Не вышло: {trustErr}</span>}
          </span>
          <button
            onClick={() => void trustNewKey()}
            className="shrink-0 rounded-md bg-rose-500/20 px-2.5 py-1 text-xs font-medium text-rose-100 ring-1 ring-rose-500/40 hover:bg-rose-500/30"
          >
            Доверять и переподключиться
          </button>
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  )
}
