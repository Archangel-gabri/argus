import { useEffect, useRef, useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import { Cpu, MemoryStick, Thermometer, ArrowDownUp, HardDrive, Gpu, Layers } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fmtBps } from '@/components/panes/OverviewPane'
import type { DeviceDTO, MetricSnapshot, LiveMetrics } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined
const clampPct = (n: number): number => Math.min(100, Math.max(0, n))

/** Мини-спарклайн из массива значений (чистый SVG — дёшево на 3-сек потоке). */
function Spark({ data, color }: { data: number[]; color: string }): React.JSX.Element {
  const max = Math.max(1, ...data)
  const w = 100
  const h = 24
  const pts = data
    .map((v, i) => `${(i / Math.max(1, data.length - 1)) * w},${h - (v / max) * h}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-6 w-full">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  pct,
  tone,
  barClass,
  spark,
  sparkColor
}: {
  icon: typeof Cpu
  label: string
  value: string
  sub?: string
  pct?: number
  tone?: string
  barClass?: string
  spark?: number[]
  sparkColor?: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <div className={cn('truncate text-lg font-semibold tabular-nums', tone ?? 'text-slate-100')}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] tabular-nums text-slate-500">{sub}</div>}
      {pct != null && (
        <div className="mt-2 h-1.5 rounded-full bg-slate-600/30">
          <div className={cn('h-full rounded-full', barClass ?? 'bg-accent')} style={{ width: `${clampPct(pct)}%` }} />
        </div>
      )}
      {spark && spark.length > 1 && <div className="mt-2">{<Spark data={spark} color={sparkColor ?? '#f59e0b'} />}</div>}
    </div>
  )
}

/** Мини-бары по ядрам (heatmap-like). Клетка = ядро, высота/цвет = загрузка. */
function CoreGrid({ cores }: { cores: number[] }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Ядра CPU · {cores.length}</div>
      <div className="flex flex-wrap items-end gap-1">
        {cores.map((c, i) => (
          <div
            key={i}
            title={`ядро ${i}: ${c}%`}
            className="flex h-10 w-[7px] items-end overflow-hidden rounded-sm bg-slate-600/25"
          >
            <div
              className={cn('w-full rounded-sm', c >= 85 ? 'bg-rose-500' : c >= 60 ? 'bg-amber-400' : 'bg-accent')}
              style={{ height: `${clampPct(Math.max(4, c))}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function MountsTable({ mounts }: { mounts: LiveMetrics['mounts'] }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Диски</div>
      <ul className="space-y-1.5">
        {mounts.slice(0, 8).map((m) => (
          <li key={m.mount} className="flex items-center gap-3 text-xs">
            <span className="w-28 shrink-0 truncate font-mono text-slate-400" title={m.mount}>
              {m.mount}
            </span>
            <div className="h-1.5 flex-1 rounded-full bg-slate-600/30">
              <div
                className={cn('h-full rounded-full', m.usedPct > 90 ? 'bg-rose-500' : m.usedPct > 75 ? 'bg-amber-400' : 'bg-accent')}
                style={{ width: `${clampPct(m.usedPct)}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-slate-300">{m.usedPct}%</span>
            <span className="w-24 shrink-0 text-right tabular-nums text-slate-500">
              {m.usedGb}/{m.totalGb} GB
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TopTable({ top }: { top: LiveMetrics['top'] }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">Топ-процессы (по CPU)</div>
      <ul className="space-y-1">
        {top.map((p, i) => (
          <li key={i} className="flex items-center gap-3 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{p.cmd}</span>
            <span className="w-14 shrink-0 text-right tabular-nums text-accent">{p.cpu.toFixed(1)}%</span>
            <span className="w-14 shrink-0 text-right tabular-nums text-slate-500">{p.mem.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MetricsPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const [live, setLive] = useState<LiveMetrics | null>(null)
  const [liveOk, setLiveOk] = useState<boolean | null>(null)
  const cpuBuf = useRef<number[]>([])
  const rxBuf = useRef<number[]>([])
  const txBuf = useRef<number[]>([])
  const [, force] = useState(0)

  // Живой поток каждые 3с (полный снимок; в историю НЕ пишется).
  useEffect(() => {
    let alive = true
    if (!api) {
      setLiveOk(false)
      return
    }
    const tick = async (): Promise<void> => {
      const r = await api.metrics.live(device.id)
      if (!alive) return
      setLiveOk(r.ok)
      if (r.ok && r.metrics) {
        const m = r.metrics
        setLive(m)
        cpuBuf.current = [...cpuBuf.current, m.cpu].slice(-40)
        rxBuf.current = [...rxBuf.current, m.netRx].slice(-40)
        txBuf.current = [...txBuf.current, m.netTx].slice(-40)
        force((n) => n + 1)
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [device.id])

  // История (снапшоты поллинга) — нижний график CPU/RAM.
  const [rows, setRows] = useState<MetricSnapshot[]>([])
  useEffect(() => {
    let alive = true
    if (!api) return
    api.metrics.history(device.id, 200).then((r) => {
      if (alive) setRows(r)
    })
    return () => {
      alive = false
    }
  }, [device.id])
  const hist = rows.map((r) => ({
    t: new Date(r.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    cpu: r.cpu ?? 0,
    ram: r.ramTotal ? Math.round(((r.ramUsed ?? 0) / r.ramTotal) * 100) : 0
  }))

  const ramPct = live && live.ramTotal ? (live.ramUsed / live.ramTotal) * 100 : 0
  const swapPct = live && live.swapTotal ? (live.swapUsed / live.swapTotal) * 100 : 0
  const tempTone =
    live?.tempCpu == null ? undefined : live.tempCpu >= 80 ? 'text-rose-400' : live.tempCpu >= 60 ? 'text-amber-400' : 'text-emerald-400'

  return (
    <div className="h-full space-y-3 overflow-y-auto pr-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">Live-метрики · обновление 3с</span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              liveOk === true ? 'bg-emerald-500' : liveOk === false ? 'bg-rose-500' : 'bg-amber-400 animate-pulse'
            )}
          />
          <span className="text-[11px] text-slate-400">
            {liveOk === true ? 'live' : liveOk === false ? 'офлайн' : 'сбор…'}
          </span>
        </span>
      </div>

      {live ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatCard icon={Cpu} label="CPU" value={`${live.cpu}%`} pct={live.cpu} spark={cpuBuf.current} sparkColor="#f59e0b" />
            <StatCard
              icon={MemoryStick}
              label="RAM"
              value={`${live.ramUsed}/${live.ramTotal} GB`}
              sub={`кэш ${live.cacheGb} GB`}
              pct={ramPct}
              tone="text-sky-400"
              barClass="bg-sky-400"
            />
            <StatCard
              icon={ArrowDownUp}
              label="Сеть"
              value={`↓ ${fmtBps(live.netRx)}`}
              sub={`↑ ${fmtBps(live.netTx)}`}
              spark={rxBuf.current}
              sparkColor="#10b981"
            />
            {live.tempCpu != null && (
              <StatCard
                icon={Thermometer}
                label="Темп."
                value={`${live.tempCpu}°C`}
                pct={clampPct(live.tempCpu)}
                tone={tempTone}
                barClass={live.tempCpu >= 80 ? 'bg-rose-500' : live.tempCpu >= 60 ? 'bg-amber-400' : 'bg-emerald-500'}
              />
            )}
            {live.gpu && (
              <StatCard
                icon={Gpu}
                label="GPU"
                value={`${live.gpu.util}% · ${live.gpu.temp}°C`}
                sub={`VRAM ${live.gpu.memUsed}/${live.gpu.memTotal} GB${live.gpu.power ? ` · ${live.gpu.power}W` : ''}`}
                pct={live.gpu.util}
              />
            )}
            {live.swapTotal > 0 && (
              <StatCard icon={Layers} label="Swap" value={`${live.swapUsed}/${live.swapTotal} GB`} pct={swapPct} tone="text-violet-400" barClass="bg-violet-400" />
            )}
            <StatCard icon={HardDrive} label="Диск I/O" value={`R ${fmtBps(live.diskR)}`} sub={`W ${fmtBps(live.diskW)}`} />
          </div>

          {live.cores.length > 0 && <CoreGrid cores={live.cores} />}
          {live.mounts.length > 0 && <MountsTable mounts={live.mounts} />}
          {live.top.length > 0 && <TopTable top={live.top} />}
        </>
      ) : (
        <div className="flex items-center justify-center rounded-lg border border-border bg-surface/40 p-6 text-center text-sm text-slate-500">
          {liveOk === false ? 'Live-метрики только в десктоп-приложении / хост офлайн.' : 'Собираю первый снимок…'}
        </div>
      )}

      {hist.length >= 2 && (
        <div className="rounded-lg border border-border bg-surface/40 p-3">
          <div className="mb-2 flex items-center gap-4 text-[11px] text-slate-400">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">История</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-3 rounded-full bg-accent" /> CPU %
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-3 rounded-full bg-sky-400" /> RAM %
            </span>
          </div>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={hist} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#2a2622" strokeDasharray="3 3" />
                <XAxis dataKey="t" tick={{ fill: '#78716c', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#2a2622' }} minTickGap={40} />
                <YAxis domain={[0, 100]} tick={{ fill: '#78716c', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#2a2622' }} />
                <Tooltip contentStyle={{ background: '#1a1816', border: '1px solid #2a2622', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#a8a29e' }} />
                <Line type="monotone" dataKey="cpu" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="ram" stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}
