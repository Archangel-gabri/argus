import { useEffect, useState } from 'react'
import { MonitorPlay, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
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
  const [loading, setLoading] = useState(false)

  const probe = async (): Promise<void> => {
    if (!api) return
    setLoading(true)
    const r = await api.screen.preflight(device.id)
    setLoading(false)
    setPf(r)
  }
  useEffect(() => {
    void probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id])

  const backendLabel =
    pf?.backend === 'nvenc'
      ? 'NVENC (аппаратный)'
      : pf?.backend === 'vaapi'
        ? 'VAAPI (аппаратный)'
        : pf?.backend === 'software'
          ? 'софт-x264'
          : '—'
  const sessionLabel =
    pf?.sessionType === 'wayland'
      ? 'Wayland'
      : pf?.sessionType === 'x11'
        ? 'X11'
        : pf?.sessionType === 'windows'
          ? 'Windows'
          : pf?.sessionType === 'headless'
            ? 'нет графической сессии'
            : '—'

  return (
    <div className="h-full space-y-3 overflow-y-auto pr-1">
      {/* Превью-заглушка — сюда встанет <video> WebRTC-потока (следующий инкремент). */}
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-bg">
        <div className="flex flex-col items-center gap-2 text-slate-600">
          <MonitorPlay className="h-10 w-10" />
          <span className="text-xs">Здесь будет экран ПК</span>
        </div>
      </div>

      {/* Пред-полётная готовность */}
      <div className="rounded-lg border border-border bg-card/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Готовность ПК</span>
          <button
            onClick={() => void probe()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} проверить
          </button>
        </div>
        {!pf ? (
          <p className="py-2 text-center text-xs text-slate-600">{loading ? 'Проверяю ПК…' : '—'}</p>
        ) : pf.error ? (
          <p className="py-1 text-center text-xs text-rose-400">{pf.error}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Row label="ОС · сессия" value={`${pf.os === 'windows' ? 'Windows' : 'Linux'} · ${sessionLabel}`} />
            <Row label="Видеокарта" value={pf.gpu || '—'} />
            <Row
              label="Энкодер"
              value={backendLabel}
              tone={pf.backend === 'software' ? 'text-amber-400' : 'text-emerald-400'}
            />
            <Row label="Стрим-агент" value={pf.agentInstalled ? 'установлен' : 'будет доставлен'} />
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

      {/* CTA + честный статус */}
      <button
        disabled
        title="Стрим-агент в разработке (Этап 4)"
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent/40 px-3 py-2.5 text-sm font-bold text-bg opacity-60"
      >
        <MonitorPlay className="h-4 w-4" /> Смотреть экран
      </button>
      <p className="text-[11px] leading-relaxed text-slate-600">
        Просмотр экрана + управление мышью/клавой встраиваются сейчас (Этап 4). Argus сам доставит стрим-агент на ПК по
        SSH при первом подключении — ставить руками ничего не нужно. Один раз потребуется подтвердить «Разрешить запись
        экрана» на самом ПК (требование безопасности Windows/Wayland), дальше — автоматически. Пока идёт сборка агента;
        эта вкладка уже проверяет готовность машины и выбранный энкодер.
      </p>
    </div>
  )
}
