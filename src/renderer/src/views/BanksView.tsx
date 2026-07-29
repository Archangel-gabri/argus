import { useEffect, useState } from 'react'
import { Bitcoin, Landmark, Wallet as WalletIcon, Pencil, Plus, Trash2, RefreshCw, X, Loader2 } from 'lucide-react'
import { Page, PageHeader, StatTile, Card, SourceBadge } from '@/components/ui/Page'
import { Donut } from '@/components/ui/Donut'
import { Hint } from '@/components/ui/Hint'
import { money } from '@/lib/format'
import { cn } from '@/lib/cn'
import { MOCK_HOLDINGS, KIND_COLOR } from '@/data/finance'
import { useWallets } from '@/store/wallets'
import type { Wallet, WalletInput } from '@/types'

const CHAINS = ['ETH', 'BTC', 'TON']
const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-accent/40'

function WalletForm({
  initial,
  onSubmit,
  onClose
}: {
  initial?: Wallet | null
  onSubmit: (i: WalletInput) => void
  onClose: () => void
}): React.JSX.Element {
  const [chain, setChain] = useState(initial?.chain ?? 'ETH')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">{initial ? 'Редактировать кошелёк' : 'Добавить кошелёк'}</h3>
          <Hint>Баланс читается публичным RPC. Нужен только адрес.</Hint>
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-slate-200">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <select className={inputCls} value={chain} onChange={(e) => setChain(e.target.value)}>
          {CHAINS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          className={cn(inputCls, 'sm:col-span-2 font-mono')}
          placeholder="Адрес кошелька"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input className={inputCls} placeholder="Метка" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <button
        onClick={() => address.trim() && onSubmit({ chain, address: address.trim(), label: label.trim() || undefined })}
        className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover"
      >
        {initial ? 'Сохранить' : 'Добавить'}
      </button>
    </Card>
  )
}

export function BanksView(): React.JSX.Element {
  const wallets = useWallets((s) => s.wallets)
  const balances = useWallets((s) => s.balances)
  const loaded = useWallets((s) => s.loaded)
  const loading = useWallets((s) => s.loading)
  const load = useWallets((s) => s.load)
  const add = useWallets((s) => s.add)
  const updateWallet = useWallets((s) => s.update)
  const remove = useWallets((s) => s.remove)
  const refresh = useWallets((s) => s.refresh)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Wallet | null>(null)

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])

  // Keep cash + brokerage as manual/soon holdings; crypto now comes from real wallets.
  const manual = MOCK_HOLDINGS.filter((h) => h.kind !== 'crypto')
  const liveUsd = wallets.reduce((s, w) => s + (balances[w.id]?.usd ?? 0), 0)
  const manualUsd = manual.reduce((s, h) => s + h.usd, 0)
  const net = liveUsd + manualUsd

  const byKind = [
    { label: 'crypto', value: liveUsd },
    ...Object.entries(
      manual.reduce<Record<string, number>>((a, h) => {
        a[h.kind] = (a[h.kind] ?? 0) + h.usd
        return a
      }, {})
    ).map(([label, value]) => ({ label, value }))
  ]
    .filter((x) => x.value > 0)
    .map((x) => ({ ...x, color: (KIND_COLOR as Record<string, string>)[x.label] ?? '#64748b' }))
    .sort((a, b) => b.value - a.value)

  return (
    <Page>
      <PageHeader
        title="Banks & Finance"
        subtitle="кошельки · брокередж · кэш"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh()}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Обновить
            </button>
            <button
              onClick={() => {
                setEditing(null)
                setAdding((v) => !v)
              }}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-bold text-bg hover:bg-accent-hover"
            >
              <Plus className="h-4 w-4" /> Кошелёк
            </button>
          </div>
        }
      />
      {(adding || editing) && (
        <WalletForm
          initial={editing}
          onSubmit={(i) => {
            if (editing) updateWallet(editing.id, i)
            else add(i)
            setAdding(false)
            setEditing(null)
          }}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}

      <div className="grid grid-cols-3 gap-4">
        <StatTile label="Net worth" value={money(net)} hint="все источники, USD" />
        <StatTile label="Live (кошельки)" value={money(liveUsd)} hint={`${wallets.length} адресов через RPC`} />
        <StatTile label="Ручные" value={money(manualUsd)} hint={`${manual.length} позиций`} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-white">Холдинги</h2>
          <div className="divide-y divide-border">
            {wallets.map((w) => {
              const bal = balances[w.id]
              return (
                <div key={w.id} className="group flex items-center gap-3 py-3 text-sm">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${KIND_COLOR.crypto}1a`, color: KIND_COLOR.crypto }}
                  >
                    <Bitcoin className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-slate-200">{w.label}</span>
                      <SourceBadge kind="live" />
                    </div>
                    <div className="truncate font-mono text-xs text-slate-500">
                      {w.chain} · {w.address.slice(0, 10)}…{w.address.slice(-6)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="tabular-nums text-slate-200">{bal?.usd != null ? money(bal.usd) : '—'}</div>
                    <div className="text-xs tabular-nums text-slate-500">
                      {bal ? `${bal.native.toFixed(4)} ${bal.symbol}` : <Loader2 className="inline h-3 w-3 animate-spin" />}
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                    <button
                      onClick={() => {
                        setEditing(w)
                        setAdding(false)
                      }}
                      className="rounded p-1 text-slate-500 hover:text-accent"
                      title="Редактировать"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => remove(w.id)}
                      className="rounded p-1 text-slate-500 hover:text-rose-400"
                      title="Удалить"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              )
            })}

            {manual.map((h) => (
              <div key={h.id} className="flex items-center gap-3 py-3 text-sm">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${KIND_COLOR[h.kind]}1a`, color: KIND_COLOR[h.kind] }}
                >
                  {h.kind === 'brokerage' ? <Landmark className="h-4 w-4" /> : <WalletIcon className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-slate-200">{h.name}</span>
                    <SourceBadge kind={h.source} />
                  </div>
                  <div className="truncate text-xs text-slate-500">{h.detail}</div>
                </div>
                <div className="text-right">
                  <div className="tabular-nums text-slate-200">{money(h.usd)}</div>
                  <div className="text-xs tabular-nums text-slate-500">
                    {h.amount} {h.unit}
                  </div>
                </div>
              </div>
            ))}

            {wallets.length === 0 && (
              <p className="py-4 text-center text-xs text-slate-500">
                Кошельков нет — добавь адрес
              </p>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-white">Аллокация</h2>
          <Donut data={byKind} center={money(net)} sub="net" />
        </Card>
      </div>
    </Page>
  )
}
