import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { X, TerminalSquare, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI } from '@/store/ui'

const api = typeof window !== 'undefined' ? window.api : undefined

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

type Status = 'connecting' | 'connected' | 'closed' | 'error'

const PILL: Record<Status, { dot: string; text: string; label: string }> = {
  connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400', label: 'connecting' },
  connected: { dot: 'bg-accent', text: 'text-accent', label: 'connected' },
  closed: { dot: 'bg-slate-500', text: 'text-slate-400', label: 'closed' },
  error: { dot: 'bg-rose-500', text: 'text-rose-400', label: 'error' }
}

export function TerminalPanel(): React.JSX.Element | null {
  const target = useUI((s) => s.terminal)
  const close = useUI((s) => s.closeTerminal)
  const hostRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!target || !hostRef.current) return
    setErrMsg(null)
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#0b0e14',
        foreground: '#cbd5e1',
        cursor: '#22d3ee',
        selectionBackground: 'rgba(34,211,238,0.25)'
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
      term.writeln('\x1b[31m✖ Terminal needs the desktop app (no Electron API in browser preview).\x1b[0m')
    } else {
      void (async () => {
        const r = await api.ssh.open(target.id, term.cols, term.rows)
        if (disposed) return
        if (!r.ok || !r.sessionId) {
          setStatus('error')
          setErrMsg(r.error ?? 'Failed to connect')
          term.writeln(`\x1b[31m✖ ${r.error ?? 'Failed to connect'}\x1b[0m`)
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
  }, [target, retry])

  const trustNewKey = async (): Promise<void> => {
    if (!target || !api) return
    await api.ssh.forgetHostKey(target.ip, target.port)
    setErrMsg(null)
    setStatus('connecting')
    setRetry((n) => n + 1)
  }

  if (!target) return null
  const pill = PILL[status]
  const hostKeyChanged = /host key changed/i.test(errMsg ?? '')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={close}
    >
      <div
        className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-[#0b0e14] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <TerminalSquare className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate text-sm font-semibold text-white">{target.name}</span>
            <span className="truncate font-mono text-xs text-slate-500">
              {target.user}@{target.ip}
            </span>
            <span className="ml-1 inline-flex items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', pill.dot)} />
              <span className={cn('text-[11px] font-medium', pill.text)}>{pill.label}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              placeholder="поиск (Enter)…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') searchRef.current?.findNext(e.currentTarget.value)
              }}
              className="w-32 rounded-md border border-border bg-bg/60 px-2 py-1 text-xs text-slate-200 outline-none transition-all focus:w-44 focus:border-accent/40"
            />
            <button
              onClick={close}
              className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
              aria-label="Close terminal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        {hostKeyChanged && (
          <div className="flex items-center gap-3 border-b border-rose-500/30 bg-rose-500/10 px-4 py-2.5">
            <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
            <span className="min-w-0 flex-1 text-xs text-rose-200">
              Ключ хоста изменился — возможен MITM. Доверяйте только если сервер переустанавливали/меняли ключ.
            </span>
            <button
              onClick={() => void trustNewKey()}
              className="shrink-0 rounded-md bg-rose-500/20 px-2.5 py-1 text-xs font-medium text-rose-100 ring-1 ring-rose-500/40 hover:bg-rose-500/30"
            >
              Доверять новому ключу и переподключиться
            </button>
          </div>
        )}
        <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
      </div>
    </div>
  )
}
