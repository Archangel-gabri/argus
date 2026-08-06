import { useEffect, useState } from 'react'
import { Bitcoin, Pencil, Plus, Trash2, X, Loader2 } from 'lucide-react'
import { Page, PageHeader, StatTile, Card } from '@/components/ui/Page'
import { Donut } from '@/components/ui/Donut'
import { Hint } from '@/components/ui/Hint'
import { approxMoney, money, plural } from '@/lib/format'
import { toUsd } from '@/data/subscriptions'
import { cn } from '@/lib/cn'
import { KIND_COLOR } from '@/data/finance'
import { AccountList } from '@/components/finance/AccountList'
import { KIND_LABEL, totals as accountTotals } from '@/lib/finance'
import { useAccounts } from '@/store/accounts'
import { useWallets } from '@/store/wallets'
import type { Currency, FinanceAccountInput, FinanceKind, Wallet, WalletInput, FinanceAccount } from '@/types'
import { CURRENCY_CODES } from '@/types'

const CHAINS = ['ETH', 'BTC', 'TON']
const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-accent/40'

function WalletForm({
  initial,
  onSubmit,
  onClose,
  error
}: {
  initial?: Wallet | null
  onSubmit: (i: WalletInput) => Promise<boolean>
  onClose: () => void
  error: string | null
}): React.JSX.Element {
  const [chain, setChain] = useState(initial?.chain ?? 'ETH')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (!address.trim() || busy) return
    setBusy(true)
    try {
      await onSubmit({ chain, address: address.trim(), label: label.trim() || undefined })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">{initial ? 'Редактировать кошелёк' : 'Добавить кошелёк'}</h3>
          <Hint>Баланс читается публичным RPC. Нужен только адрес.</Hint>
        </div>
        <button onClick={onClose} className="rounded p-1.5 text-slate-400 hover:text-slate-200">
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
      {error && <p role="alert" className="mt-2 text-xs text-rose-400">{error}</p>}
      <button
        onClick={() => void submit()}
        disabled={busy || !address.trim()}
        className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Сохраняю…' : initial ? 'Сохранить' : 'Добавить'}
      </button>
    </Card>
  )
}


/**
 * Форма счёта.
 *
 * Появилась не от хорошей жизни: завести счёт из приложения было НЕЛЬЗЯ вовсе — метод в сторе
 * существовал, но ни одна кнопка его не звала, и счета попадали в хранилище только из локального
 * файла засева. При этом удалить счёт кнопка позволяла. То есть основной сценарий раздела
 * («веду свои счета») работал в одну сторону.
 */
function AccountForm({
  initial,
  onSubmit,
  onClose,
  error
}: {
  /** Счёт, который правим. Пусто — заводим новый. */
  initial?: FinanceAccount
  onSubmit: (i: FinanceAccountInput) => Promise<boolean>
  onClose: () => void
  error: string | null
}): React.JSX.Element {
  const [kind, setKind] = useState<FinanceKind>(initial?.kind ?? 'bank')
  const [name, setName] = useState(initial?.name ?? '')
  const [institution, setInstitution] = useState(initial?.institution ?? '')
  const [currency, setCurrency] = useState<Currency>(initial?.currency ?? 'RUB')
  const [balance, setBalance] = useState(initial?.balance != null ? String(initial.balance) : '')
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (busy) return
    if (!name.trim()) {
      setValidation('Укажи название счёта')
      return
    }
    // Пробелы-разделители и запятая — обычный ввод остатка («125 000», «1250,50»).
    const raw = balance.trim().replace(/\s/g, '').replace(',', '.')
    const value = raw === '' ? null : Number(raw)
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      setValidation(`Не понимаю остаток «${balance.trim()}» — нужно неотрицательное число`)
      return
    }
    setValidation(null)
    setBusy(true)
    try {
      const ok = await onSubmit({
        kind,
        name: name.trim(),
        institution: institution.trim(),
        currency,
        balance: value,
        // Правка руками — это ручной источник, даже если раньше остаток приходил по ключу.
        source: 'manual'
      })
      if (ok) onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">{initial ? 'Изменить счёт' : 'Добавить счёт'}</h3>
          <Hint>Банк, брокер, биржа, кошелёк или наличные. Остаток можно вписать позже.</Hint>
        </div>
        <button onClick={onClose} className="rounded p-1.5 text-slate-400 hover:text-slate-200" aria-label="Закрыть">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as FinanceKind)} aria-label="Тип счёта">
          {(Object.keys(KIND_LABEL) as FinanceKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input className={inputCls} placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} aria-label="Название счёта" />
        <input
          className={inputCls}
          placeholder="Банк / биржа"
          value={institution}
          onChange={(e) => setInstitution(e.target.value)}
          aria-label="Учреждение"
        />
        <select className={inputCls} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-label="Валюта">
          {CURRENCY_CODES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          className={inputCls}
          inputMode="decimal"
          placeholder="Остаток"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          aria-label="Остаток"
        />
      </div>
      {(validation || error) && (
        <p role="alert" className="mt-2 text-xs text-rose-400">
          {validation || error}
        </p>
      )}
      <button
        onClick={() => void submit()}
        disabled={busy || !name.trim()}
        className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Сохраняю…' : 'Добавить'}
      </button>
    </Card>
  )
}

export function BanksView(): React.JSX.Element {
  const accounts = useAccounts((s) => s.accounts)
  const accountsLoaded = useAccounts((s) => s.loaded)
  const loadAccounts = useAccounts((s) => s.load)
  const wallets = useWallets((s) => s.wallets)
  const balances = useWallets((s) => s.balances)
  const balanceLoading = useWallets((s) => s.balanceLoading)
  const balanceErrors = useWallets((s) => s.balanceErrors)
  const loaded = useWallets((s) => s.loaded)
  const error = useWallets((s) => s.error)
  const load = useWallets((s) => s.load)
  const add = useWallets((s) => s.add)
  const updateWallet = useWallets((s) => s.update)
  const remove = useWallets((s) => s.remove)
  const refresh = useWallets((s) => s.refresh)
  const refreshAccounts = useAccounts((s) => s.refresh)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Wallet | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const [editingAccount, setEditingAccount] = useState<FinanceAccount | null>(null)
  const addAccount = useAccounts((s) => s.add)
  const updateAccount = useAccounts((s) => s.update)
  // Стор счетов складывал ошибку в восьми местах, и её не показывал никто: неудачная правка
  // остатка выглядела как «кнопка не работает».
  const accountsError = useAccounts((s) => s.error)

  useEffect(() => {
    if (!loaded) load()
  }, [loaded, load])
  useEffect(() => {
    if (!accountsLoaded) void loadAccounts()
  }, [accountsLoaded, loadAccounts])

  // Кнопки «Обновить» здесь больше нет: она требовала помнить о ней и нажимать, а всё, что
  // умеет обновляться само (остатки бирж по ключу, балансы кошельков по RPC), обновляется при
  // открытии раздела. Кнопка, которую надо нажимать каждый раз, — это не функция, а
  // недоделанная автоматика.
  useEffect(() => {
    void refresh()
    void refreshAccounts()
    // Один раз на открытие экрана: чаще незачем, реже — цифры устареют незаметно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const accountSums = accountTotals(accounts, Date.now())
  const liveUsd = wallets.reduce((s, w) => s + (balances[w.id]?.usd ?? 0), 0)
  const net = liveUsd + accountSums.usd
  // Пометка «≈» нужна там, где КОНВЕРТАЦИЯ реально была, а не там, где валют несколько.
  //
  // Первая редакция проверяла разнообразие (`size > 1`) — и на самом частом наборе данных
  // молчала: у владельца все счета в рублях, кошельков с балансом нет, значит валюта одна и
  // «≈» не ставилось. А итог всё равно получен умножением на вшитый курс 0.0126. То есть
  // правка, сделанная ради честности цифры, на живых данных её и не давала.
  const currencies = accounts.filter((a) => a.balance != null).map((a) => a.currency)
  const unavailable = wallets.filter((wallet) => balanceErrors[wallet.id] || balances[wallet.id]?.status === 'error').length

  // Группируем по ТИПУ счёта, а подпись и цвет берём от него же. Раньше ключом группы служила
  // русская подпись, а цвет искался по ней в карте с английскими ключами — не совпадало ничего,
  // и все секторы, кроме крипты, оказывались одного цвета.
  const byKind = [
    { kind: 'crypto' as const, label: 'Криптокошельки', value: liveUsd },
    ...Object.entries(
      accounts.reduce<Record<string, number>>((a, x) => {
        if (x.balance == null) return a
        a[x.kind] = (a[x.kind] ?? 0) + toUsd(x.balance, x.currency)
        return a
      }, {})
    ).map(([kind, value]) => ({
      kind: kind as FinanceKind,
      label: KIND_LABEL[kind as FinanceKind] ?? kind,
      value
    }))
  ]
    .filter((x) => x.value > 0)
    .map((x) => ({ label: x.label, value: x.value, color: KIND_COLOR[x.kind] ?? '#64748b' }))
    .sort((a, b) => b.value - a.value)

  return (
    <Page>
      <PageHeader
        title="Финансы"
        subtitle={`${accounts.length + wallets.length} ${plural(accounts.length + wallets.length, 'источник', 'источника', 'источников')}`}
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setAdding(false)
                setEditing(null)
                setAddingAccount((v) => !v)
              }}
              className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover"
            >
              <Plus className="h-4 w-4" /> Счёт
            </button>
            <button
              onClick={() => {
                setAddingAccount(false)
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
      {/* key даёт форме идентичность цели правки. Без него переход «карандаш у A →
          карандаш у B» не перемонтирует компонент: React видит тот же элемент,
          useState сохраняет значения формы A, а «Сохранить» отправляет их с
          идентификатором B — то есть молча подменяет чужую запись. */}
      {(addingAccount || editingAccount) && (
        <AccountForm
          // key даёт форме идентичность цели правки: без него переход «карандаш у A → карандаш
          // у B» не перемонтирует компонент, и «Сохранить» отправит поля A на запись B.
          key={editingAccount?.id ?? 'new'}
          initial={editingAccount ?? undefined}
          error={accountsError}
          onClose={() => {
            setAddingAccount(false)
            setEditingAccount(null)
          }}
          onSubmit={(input) => (editingAccount ? updateAccount(editingAccount.id, input) : addAccount(input))}
        />
      )}
      {accountsError && !addingAccount && !editingAccount && (
        <p role="alert" className="mb-3 text-xs text-rose-400">
          Счета: {accountsError}
        </p>
      )}
      {(adding || editing) && (
        <WalletForm
          key={editing?.id ?? 'new'}
          initial={editing}
          error={error}
          onSubmit={async (input) => {
            const ok = editing ? await updateWallet(editing.id, input) : await add(input)
            if (ok) {
              setAdding(false)
              setEditing(null)
            }
            return ok
          }}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}

      {/* Плитка одна и говорит одно: сколько денег известно.
          Их было три. Сначала две считали ПРОБЕЛЫ в данных («не внесено 6», «устарело 0») —
          счётчик недоделанной работы вместо состояния счетов. На смену им пришли «где основное»
          и «по валютам», и владелец назвал их бредом — справедливо: при одном заполненном счёте
          «основное» это тот же счёт, а «по валютам RUB 100 %» не сообщает ничего. Плитка обязана
          отвечать на вопрос, ответ на который заранее неизвестен. Полнота данных осталась
          подписью под самой цифрой, где она и уместна. */}
      <div className="grid grid-cols-1 gap-4">
        <StatTile
          label="Известно"
          value={approxMoney(net, currencies)}
          hint={
            accountSums.unknown + unavailable > 0
              ? `по ${accountSums.known + (wallets.length - unavailable)} из ${accounts.length + wallets.length} источников · остальные без остатка`
              : `по всем ${accounts.length + wallets.length} источникам`
          }
        />
      </div>

      {error && !adding && !editing && <p role="alert" className="mt-3 text-xs text-rose-400">{error}</p>}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          {accounts.length > 0 && (
            <div className="mb-5">
              <h2 className="mb-3 text-sm font-semibold text-white">Счета</h2>
              <AccountList
                accounts={accounts}
                onEdit={(a) => {
                  setAddingAccount(false)
                  setEditingAccount(a)
                }}
              />
            </div>
          )}
          <h2 className="mb-3 text-sm font-semibold text-white">Криптокошельки</h2>
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
                    </div>
                    <div className="truncate font-mono text-xs text-slate-500">
                      {w.chain} · {w.address.slice(0, 10)}…{w.address.slice(-6)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="tabular-nums text-slate-200">{bal?.usd != null ? money(bal.usd) : '—'}</div>
                    <div
                      className={cn('text-xs tabular-nums', balanceErrors[w.id] ? 'text-rose-400' : 'text-slate-500')}
                      title={balanceErrors[w.id]}
                    >
                      {balanceLoading[w.id] && !bal ? (
                        <Loader2 className="inline h-3 w-3 animate-spin" />
                      ) : bal?.native != null ? (
                        `${bal.native.toFixed(4)} ${bal.symbol}${balanceErrors[w.id] ? ' · устарело' : ''}`
                      ) : (
                        balanceErrors[w.id] ?? 'баланс неизвестен'
                      )}
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      onClick={() => {
                        setEditing(w)
                        setAdding(false)
                      }}
                      className="rounded p-1.5 text-slate-500 hover:text-accent"
                      title="Редактировать"
                      aria-label={`Редактировать кошелёк ${w.label}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => void remove(w.id)}
                      className="rounded p-1.5 text-slate-500 hover:text-rose-400"
                      title="Удалить"
                      aria-label={`Удалить кошелёк ${w.label}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              )
            })}

            {wallets.length === 0 && (
              <p className="py-4 text-center text-xs text-slate-500">
                Кошельков нет — добавь адрес
              </p>
            )}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-white">Аллокация</h2>
          <Donut data={byKind} center={approxMoney(net, currencies)} sub="всего" />
        </Card>
      </div>
    </Page>
  )
}
