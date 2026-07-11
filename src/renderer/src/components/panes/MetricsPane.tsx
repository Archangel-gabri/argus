import { useEffect, useState } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from 'recharts'
import type { DeviceDTO, MetricSnapshot } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

export function MetricsPane({ device }: { device: DeviceDTO }): React.JSX.Element {
  const [rows, setRows] = useState<MetricSnapshot[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    if (!api) {
      setLoaded(true)
      return
    }
    api.metrics.history(device.id, 200).then((r) => {
      if (alive) {
        setRows(r)
        setLoaded(true)
      }
    })
    return () => {
      alive = false
    }
  }, [device.id])

  const data = rows.map((r) => ({
    t: new Date(r.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
    cpu: r.cpu ?? 0,
    ram: r.ramTotal ? Math.round(((r.ramUsed ?? 0) / r.ramTotal) * 100) : 0
  }))

  if (loaded && data.length < 2) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-border bg-surface/40 p-6 text-center text-sm text-slate-500">
        История копится поллингом каждые 90с — открой позже или нажми ↻ на экране Fleet.
        {!api && ' (в browser-preview истории нет)'}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto rounded-lg border border-border bg-surface/40 p-3">
      <div className="mb-2 flex items-center gap-4 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-accent" /> CPU %
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-sky-400" /> RAM %
        </span>
      </div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#2a2622" strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              tick={{ fill: '#78716c', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#2a2622' }}
              minTickGap={40}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: '#78716c', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#2a2622' }}
            />
            <Tooltip
              contentStyle={{ background: '#1a1816', border: '1px solid #2a2622', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#a8a29e' }}
            />
            <Line type="monotone" dataKey="cpu" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="ram" stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-slate-600">
        Снапшоты agentless-поллинга (≤200 на устройство, каждые 90с при разблокированном vault).
      </p>
    </div>
  )
}
