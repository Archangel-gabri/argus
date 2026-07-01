import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'

export interface Slice {
  label: string
  value: number
  color: string
}

export function Donut({
  data,
  center,
  sub,
  size = 150
}: {
  data: Slice[]
  center: string
  sub?: string
  size?: number
}): React.JSX.Element {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ height: size, width: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={size * 0.35}
              outerRadius={size * 0.48}
              paddingAngle={2}
              stroke="none"
            >
              {data.map((d) => (
                <Cell key={d.label} fill={d.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {sub && <span className="text-[10px] uppercase tracking-wider text-slate-500">{sub}</span>}
          <span className="text-base font-semibold tabular-nums text-white">{center}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: d.color }} />
            <span className="flex-1 truncate text-slate-300">{d.label}</span>
            <span className="font-medium tabular-nums text-slate-400">
              {total ? Math.round((d.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
