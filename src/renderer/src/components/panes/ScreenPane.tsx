// Вкладка «Экран» — пусковая площадка, а не плеер. Сам экран живёт в ОТДЕЛЬНОМ окне
// (см. ScreenWindow.tsx): так «свернуть»/«закрыть»/«во весь экран» работают средствами ОС,
// сеанс не умирает при закрытии drawer'а, и можно смотреть на ПК, параллельно работая в Argus.
import { useEffect, useState } from 'react'
import { MonitorPlay, Loader2, RefreshCw, AlertTriangle, ExternalLink, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { DeviceDTO, ScreenPreflight } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

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
  const [opening, setOpening] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  // Факт наличия сохранённого пароля приходит из main; само значение через IPC не ходит.
  const [saved, setSaved] = useState(!!device.hasScreenSecret)
  useEffect(() => setSaved(!!device.hasScreenSecret), [device.hasScreenSecret, device.id])

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

  const open = async (): Promise<void> => {
    if (!api) return
    if (!password && !saved) {
      setErr('Введи пароль Windows-аккаунта')
      return
    }
    setOpening(true)
    setErr(null)
    const r = await api.screen.open(device.id, { password, remember: remember && !!password })
    setOpening(false)
    if (!r.ok) {
      setErr(r.error ?? 'не удалось запустить сеанс')
      return
    }
    if (password && remember) setSaved(true)
    setPassword('') // пароль ушёл в main и больше в интерфейсе не нужен
  }

  const forget = async (): Promise<void> => {
    if (!api) return
    await api.screen.forgetPassword(device.id)
    setSaved(false)
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
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-bg/40 px-4 py-7 text-center">
        <MonitorPlay className="h-9 w-9 text-slate-600" />
        <div className="text-sm font-medium text-slate-300">Экран откроется в отдельном окне</div>
        <p className="max-w-sm text-[11px] leading-relaxed text-slate-500">
          Его можно развернуть на весь монитор, свернуть в панель задач или кинуть на второй экран — и
          продолжать работать в Argus, пока смотришь на ПК.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void open()
          }}
          placeholder={saved ? 'Пароль сохранён — можно просто открыть' : 'Пароль Windows-аккаунта'}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40"
        />
        <button
          onClick={() => void open()}
          disabled={opening}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
        >
          {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />} Открыть
          экран
        </button>
      </div>
      <div className="flex items-center justify-between text-[11px]">
        {saved ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-300/80">
            <Lock className="h-3 w-3" /> пароль сохранён в хранилище
          </span>
        ) : (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-500">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3 w-3 accent-accent"
            />
            запомнить пароль (в зашифрованном хранилище)
          </label>
        )}
        {saved && (
          <button onClick={() => void forget()} className="text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline">
            забыть
          </button>
        )}
      </div>
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
        Просмотр + управление мышью и клавиатурой (Windows), синхронизация буфера обмена. Argus сам включает
        удалённый доступ по SSH — только в твоей Tailscale-сети. Единый агент для Linux/Wayland и чужих ПК без
        admin — следующий инкремент.
      </p>
    </div>
  )
}
