import { Plus, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { approxMoney } from '@/lib/format'
import { useDevices, totals } from '@/store/devices'
import { useUI } from '@/store/ui'
import { SpendPie } from './SpendPie'

function Title({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-2">
      {Icon && <Icon className="h-4 w-4 text-accent" />}
      <h2 className="text-sm font-semibold text-white">{children}</h2>
    </div>
  )
}

export function InsightsPanel(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const openCreate = useUI((s) => s.openCreate)
  const { monthly, yearly } = totals(devices)
  // Валюты слагаемых нужны, чтобы отличить «посчитано» от «сведено по вшитому курсу».
  const spendCurrencies = devices.filter((d) => d.cost.usd > 0).map((d) => d.cost.currency)

  return (
    <div className="space-y-7">
      <button
        onClick={openCreate}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-bold text-bg transition-colors hover:bg-accent-hover"
      >
        <Plus className="h-[18px] w-[18px]" /> Добавить устройство
      </button>

      <section>
        <Title>Расходы</Title>
        <div className="rounded-xl border border-border bg-card/60 p-4">
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-slate-400">В месяц</span>
            <span className="text-lg font-semibold tabular-nums text-white">{approxMoney(monthly, spendCurrencies)}</span>
          </div>
          <div className="my-1 h-px bg-border" />
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-slate-400">В год</span>
            <span className="text-lg font-semibold tabular-nums text-white">{approxMoney(yearly, spendCurrencies)}</span>
          </div>
        </div>
      </section>

      <section>
        <Title>По хостерам</Title>
        <SpendPie />
      </section>
    </div>
  )
}
