import { Page, PageHeader, StatTile, Card } from '@/components/ui/Page'
import { money } from '@/lib/format'
import { useDevices, totals } from '@/store/devices'
import { useWallets } from '@/store/wallets'
import { useAi } from '@/store/ai'

export function DashboardView(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const { monthly } = totals(devices)
  const balances = useWallets((s) => s.balances)
  const wallets = useWallets((s) => s.wallets)
  const aiAccounts = useAi((s) => s.accounts)
  const aiChecks = useAi((s) => s.checks)

  const net = Object.values(balances).reduce((s, b) => s + (b.usd ?? 0), 0)
  const online = devices.filter((d) => d.status === 'online').length
  const aiValid = aiAccounts.filter((a) => aiChecks[a.id]?.status === 'valid').length

  return (
    <Page>
      <PageHeader title="Dashboard" subtitle="everything at a glance" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Fleet" value={String(devices.length)} hint={`${online} online`} />
        <StatTile label="Infra / month" value={money(monthly)} />
        <StatTile
          label="Net worth"
          value={money(net)}
          hint={wallets.length ? `${wallets.length} кошельков live` : 'добавь кошелёк во Finance'}
        />
        <StatTile
          label="AI"
          value={String(aiAccounts.length)}
          hint={aiAccounts.length ? `${aiValid} valid по проверкам` : 'добавь первый ключ'}
        />
      </div>

      <Card className="mt-6">
        <h2 className="text-sm font-semibold text-white">Welcome back, Danya 👋</h2>
        <p className="mt-1 text-sm text-slate-400">
          Это сводка командного центра. Открой <span className="text-accent">Fleet</span> для серверов и
          устройств, <span className="text-accent">Finance</span> для денег,{' '}
          <span className="text-accent">Subscriptions</span> для трат, <span className="text-accent">AI</span> для ключей.
        </p>
      </Card>
    </Page>
  )
}
