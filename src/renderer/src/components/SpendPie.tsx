import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import { useDevices, spendByProvider, totals } from '@/store/devices'
import { providerHex } from '@/lib/providers'
import { money, pct } from '@/lib/format'

export function SpendPie(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const data = spendByProvider(devices)
  const monthly = totals(devices).monthly

  if (monthly <= 0) {
    return <p className="text-xs text-slate-500">No tracked spend yet.</p>
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[150px] w-[150px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="usd"
              nameKey="provider"
              innerRadius={52}
              outerRadius={72}
              paddingAngle={2}
              stroke="none"
            >
              {data.map((d) => (
                <Cell key={d.provider} fill={providerHex(d.provider)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">/ month</span>
          <span className="text-base font-semibold tabular-nums text-white">{money(monthly)}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5">
        {data.map((d) => (
          <li key={d.provider} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: providerHex(d.provider) }}
            />
            <span className="flex-1 truncate text-slate-300">{d.provider}</span>
            <span className="font-medium tabular-nums text-slate-400">
              {pct((d.usd / monthly) * 100)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
