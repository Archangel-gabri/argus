import { Page, PageHeader, StatTile, Card } from '@/components/ui/Page'
import { money } from '@/lib/format'
import { useDevices, totals } from '@/store/devices'
import { MOCK_HOLDINGS } from '@/data/finance'
import { MOCK_AI } from '@/data/ai'

export function DashboardView(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const { monthly } = totals(devices)
  const net = MOCK_HOLDINGS.reduce((s, h) => s + h.usd, 0)
  const online = devices.filter((d) => d.status === 'online').length

  return (
    <Page>
      <PageHeader title="Dashboard" subtitle="everything at a glance" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Servers" value={String(devices.length)} hint={`${online} online`} />
        <StatTile label="Infra / month" value={money(monthly)} />
        <StatTile label="Net worth" value={money(net)} hint="all sources" />
        <StatTile
          label="AI accounts"
          value={String(MOCK_AI.length)}
          hint={`${MOCK_AI.filter((a) => a.keyValid).length} keys valid`}
        />
      </div>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-white">Welcome back, Danya 👋</h2>
        <p className="mt-1 text-sm text-slate-400">
          Это сводка командного центра. Открой <span className="text-accent">Devices</span> для серверов и
          SSH, <span className="text-accent">Subscriptions</span> для трат, <span className="text-accent">AI
          Accounts</span> для ключей.
        </p>
      </Card>
    </Page>
  )
}
