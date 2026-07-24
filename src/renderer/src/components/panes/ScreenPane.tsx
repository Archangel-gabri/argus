import { useEffect, useRef, useState } from 'react'
import { MonitorPlay, Loader2, RefreshCw, AlertTriangle, Power } from 'lucide-react'
import Guacamole from 'guacamole-common-js'
import { cn } from '@/lib/cn'
import type { DeviceDTO, ScreenPreflight } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined
type Conn = 'idle' | 'connecting' | 'connected' | 'error'

function Row({ label, value, tone }: { label: string; value: string; tone?: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/70 bg-bg/30 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cn('mt-0.5 truncate', tone ?? 'text-slate-200')} title={value}>
        {value}
      </div>
    </div>
  )
}

export function ScreenPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const [pf, setPf] = useState<ScreenPreflight | null>(null)
  const [pfLoading, setPfLoading] = useState(false)
  const [conn, setConn] = useState<Conn>('idle')
  const [err, setErr] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const displayRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kbRef = useRef<any>(null)

  const probe = async (): Promise<void> => {
    if (!api) return
    setPfLoading(true)
    const r = await api.screen.preflight(device.id)
    setPfLoading(false)
    setPf(r)
  }
  useEffect(() => {
    void probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  const disconnect = (): void => {
    try {
      kbRef.current?.reset?.()
      clientRef.current?.disconnect?.()
    } catch {
      /* ignore */
    }
    clientRef.current = null
    kbRef.current = null
    displayRef.current?.replaceChildren()
    setConn('idle')
  }
  // Гасим сеанс при размонтировании (закрытие drawer / смена устройства).
  useEffect(() => () => disconnect(), [])

  const connect = async (): Promise<void> => {
    if (!api || !displayRef.current) return
    if (!password) {
      setErr('Введи пароль Windows-аккаунта')
      return
    }
    setConn('connecting')
    setErr(null)
    const el = displayRef.current
    const w = Math.max(1024, Math.round(el.clientWidth || 1280))
    const h = Math.round((w * 9) / 16)
    const r = await api.screen.start(device.id, { password, width: w, height: h })
    if (!r.ok || !r.wsPort || !r.token) {
      setConn('error')
      setErr(r.error ?? 'не удалось запустить сеанс')
      return
    }
    try {
      const tunnel = new Guacamole.WebSocketTunnel(`ws://127.0.0.1:${r.wsPort}/`)
      const client = new Guacamole.Client(tunnel)
      clientRef.current = client
      el.replaceChildren()
      const disp = client.getDisplay()
      el.appendChild(disp.getElement())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.onstatechange = (s: number): void => {
        if (s === 3) {
          setConn('connected')
          const scale = (el.clientWidth || w) / w
          try {
            disp.scale(scale)
          } catch {
            /* ignore */
          }
          el.focus()
        }
        if (s === 5) setConn('idle')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.onerror = (e: any): void => {
        setConn('error')
        setErr(e?.message || 'ошибка RDP-соединения (проверь пароль/готовность ПК)')
        disconnect()
      }
      client.connect(`token=${encodeURIComponent(r.token)}`)

      // Ввод: мышь по элементу дисплея, клавиатура — по контейнеру (в фокусе).
      const mouse = new Guacamole.Mouse(disp.getElement())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const send = (state: any): void => client.sendMouseState(state)
      mouse.onmousedown = send
      mouse.onmouseup = send
      mouse.onmousemove = send
      const keyboard = new Guacamole.Keyboard(el)
      keyboard.onkeydown = (sym: number): void => client.sendKeyEvent(1, sym)
      keyboard.onkeyup = (sym: number): void => client.sendKeyEvent(0, sym)
      kbRef.current = keyboard
    } catch (e) {
      setConn('error')
      setErr((e as Error).message)
    }
  }

  const backendLabel =
    pf?.backend === 'nvenc'
      ? 'NVENC'
      : pf?.backend === 'vaapi'
        ? 'VAAPI'
        : pf?.backend === 'software'
          ? 'софт'
          : '—'
  const sessionLabel =
    pf?.sessionType === 'wayland'
      ? 'Wayland'
      : pf?.sessionType === 'x11'
        ? 'X11'
        : pf?.sessionType === 'windows'
          ? 'Windows'
          : pf?.sessionType === 'headless'
            ? 'нет сессии'
            : '—'

  return (
    <div className="h-full space-y-3 overflow-y-auto pr-1">
      {/* Экран ПК (сюда guacamole рисует canvas) */}
      <div
        ref={displayRef}
        tabIndex={0}
        className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-bg outline-none focus:ring-1 focus:ring-accent/40"
      >
        {conn !== 'connected' && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-600">
            {conn === 'connecting' ? (
              <>
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-xs">Подключаюсь к экрану…</span>
              </>
            ) : (
              <>
                <MonitorPlay className="h-10 w-10" />
                <span className="text-xs">Экран ПК появится здесь</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Управление сеансом */}
      {conn === 'connected' ? (
        <button
          onClick={disconnect}
          className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-rose-300 ring-1 ring-rose-500/30 hover:bg-rose-500/10"
        >
          <Power className="h-4 w-4" /> Отключить
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void connect()
            }}
            placeholder="Пароль Windows-аккаунта"
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40"
          />
          <button
            onClick={() => void connect()}
            disabled={conn === 'connecting'}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
          >
            {conn === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MonitorPlay className="h-4 w-4" />} Смотреть
          </button>
        </div>
      )}
      {err && <div className="text-xs text-rose-400">{err}</div>}

      {/* Готовность ПК (preflight) */}
      <div className="rounded-lg border border-border bg-card/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Готовность ПК</span>
          <button
            onClick={() => void probe()}
            disabled={pfLoading}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
          >
            {pfLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} проверить
          </button>
        </div>
        {!pf ? (
          <p className="py-2 text-center text-xs text-slate-600">{pfLoading ? 'Проверяю ПК…' : '—'}</p>
        ) : pf.error ? (
          <p className="py-1 text-center text-xs text-rose-400">{pf.error}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Row label="ОС · сессия" value={`${pf.os === 'windows' ? 'Windows' : 'Linux'} · ${sessionLabel}`} />
            <Row label="Видеокарта" value={pf.gpu || '—'} />
            <Row label="Энкодер" value={backendLabel} />
            <Row label="Стрим-агент" value={pf.agentInstalled ? 'установлен' : 'RDP-путь'} />
          </div>
        )}
        {pf?.warnings?.map((w, i) => (
          <div
            key={i}
            className="mt-2 flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200/90 ring-1 ring-amber-500/20"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-600">
        Просмотр + управление мышью/клавой (Windows). Argus сам включает удалённый доступ по SSH (только в твоей
        Tailscale-сети) и рисует экран прямо здесь — ставить руками ничего не нужно. Единый агент для Linux/Wayland и
        чужих ПК без admin — следующий инкремент.
      </p>
    </div>
  )
}
