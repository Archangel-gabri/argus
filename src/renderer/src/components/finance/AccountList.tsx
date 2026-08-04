import { useState } from 'react'
import { Building2, Check, KeyRound, Landmark, LineChart, Pencil, Trash2, Wallet, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { KIND_LABEL, balanceAge, groupByKind } from '@/lib/finance'
import { useAccounts } from '@/store/accounts'
import type { FinanceAccount, FinanceKind } from '@/types'

const ICON: Record<FinanceKind, typeof Landmark> = {
  bank: Landmark,
  broker: LineChart,
  exchange: Building2,
  ewallet: Wallet,
  cash: Wallet
}

/**
 * Строка счёта.
 *
 * Остаток здесь правится на месте, а не в отдельной форме: у российских банков API нет, вписывать
 * цифру придётся регулярно, и каждый лишний шаг между «увидел в приложении банка» и «внёс сюда»
 * — это шаг, после которого цифру не внесут вовсе.
 */
function AccountRow({ account, now }: { account: FinanceAccount; now: number }): React.JSX.Element {
  const update = useAccounts((s) => s.update)
  const remove = useAccounts((s) => s.remove)
  const setCreds = useAccounts((s) => s.setCreds)
  const [editing, setEditing] = useState(false)
  const [keys, setKeys] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const Icon = ICON[account.kind] ?? Landmark
  // Возраст показывается и у автоматических: если опрос перестал получаться, цифра стареет
  // молча, и «обновляется само» превращается в неправду.
  const age = balanceAge(account.balanceAt, now)

  const save = async (): Promise<void> => {
    const raw = draft.trim().replace(/\s/g, '').replace(',', '.')
    const value = raw === '' ? null : Number(raw)
    if (value !== null && (!Number.isFinite(value) || value < 0)) return
    setBusy(true)
    try {
      // Время замера ставит хранилище — и только когда цифра действительно изменилась.
      if (await update(account.id, { name: account.name, balance: value })) setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    <div className="group flex items-center gap-3 py-2.5 text-sm">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-slate-400">
        <Icon className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-slate-200">{account.name}</span>
          {account.source === 'api' && (
            <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
              по ключу
            </span>
          )}
          {account.source === 'manual' && account.keyRef && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400/90"
              title={account.keyRef}
            >
              <KeyRound className="h-2.5 w-2.5" />
              можно автоматом
            </span>
          )}
        </div>
        {account.institution && account.institution !== account.name && (
          <div className="truncate text-xs text-slate-500">{account.institution}</div>
        )}
      </div>

      <div className="shrink-0 text-right">
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
                if (e.key === 'Escape') setEditing(false)
              }}
              placeholder="остаток"
              aria-label={`Остаток на счёте ${account.name}`}
              className="w-28 rounded border border-accent/40 bg-bg/60 px-2 py-1 text-right text-sm tabular-nums text-slate-100 outline-none"
            />
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded p-1 text-emerald-400 hover:bg-white/5"
              aria-label="Сохранить остаток"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded p-1 text-slate-500 hover:text-slate-300"
              aria-label="Отменить"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setDraft(account.balance == null ? '' : String(account.balance))
              setEditing(true)
            }}
            className="block w-full text-right"
            title="Вписать остаток"
          >
            {account.balance == null ? (
              // Пустое место, а не ноль: ноль означал бы «денег нет», а мы просто не спрашивали.
              <span className="text-[12px] text-slate-500">остаток не внесён</span>
            ) : (
              <span className="tabular-nums text-slate-200">{money(account.balance, account.currency)}</span>
            )}
            <div
              className={cn(
                'text-[11px] tabular-nums',
                age?.level === 'stale' ? 'text-amber-400/80' : 'text-slate-600'
              )}
            >
              {/* Возраст показывается только когда он что-то значит: свежая цифра молчит. */}
              {age && age.level !== 'fresh'
                ? account.source === 'api'
                  ? `обновлено ${age.days} дн. назад`
                  : `вписано ${age.days} дн. назад`
                : account.source === 'api'
                  ? 'обновляется само'
                  : ''}
            </div>
          </button>
        )}
      </div>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {(account.kind === 'exchange' || account.kind === 'broker') && (
          <button
            onClick={() => setKeys((v) => !v)}
            className={cn('rounded p-1 hover:text-accent', account.hasCreds ? 'text-emerald-400/80' : 'text-slate-500')}
            aria-label={`Ключи ${account.name}`}
            title={account.hasCreds ? 'Ключи заведены — остаток обновляется сам' : 'Завести ключ только на чтение'}
          >
            <KeyRound className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => {
            setDraft(account.balance == null ? '' : String(account.balance))
            setEditing(true)
          }}
          className="rounded p-1 text-slate-500 hover:text-accent"
          aria-label={`Изменить остаток ${account.name}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void remove(account.id)}
          className="rounded p-1 text-slate-500 hover:text-rose-400"
          aria-label={`Удалить счёт ${account.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
    {keys && <CredsForm account={account} onSave={setCreds} onClose={() => setKeys(false)} />}
    </>
  )
}

/**
 * Ввод ключа биржи.
 *
 * Ключ уходит в main и обратно не возвращается никогда — поэтому поля всегда пустые, даже когда
 * ключ уже сохранён: показать «••••» значило бы намекнуть, что значение доступно интерфейсу.
 */
function CredsForm({
  account,
  onSave,
  onClose
}: {
  account: FinanceAccount
  onSave: (id: string, creds: { apiKey: string; secret: string; passphrase?: string }) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const needsPassphrase = /okx/i.test(`${account.institution} ${account.name}`)
  // У Т-Инвестиций один токен и никакого секрета: показывать пустые поля «Secret» и
  // «Passphrase» рядом с ним значит спрашивать то, чего не существует.
  const tokenOnly = account.kind === 'broker'
  const field =
    'w-full rounded border border-border bg-bg/60 px-2 py-1 text-xs text-slate-200 outline-none focus:border-accent/40'

  return (
    <div className="mb-2 rounded-lg border border-border bg-card/40 p-3">
      <p className="mb-2 text-[11px] text-slate-500">
        {tokenOnly
          ? 'Токен «только чтение»: т-банк.ру → Инвестиции → Настройки → Токены для API. Значение уходит в зашифрованное хранилище и наружу больше не возвращается.'
          : 'Ключ только на чтение, без права на вывод средств. Значение уходит в зашифрованное хранилище и наружу больше не возвращается.'}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          className={cn(field, tokenOnly && 'sm:col-span-3')}
          type={tokenOnly ? 'password' : 'text'}
          placeholder={tokenOnly ? 'Токен' : 'API key'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          aria-label={tokenOnly ? 'Токен' : 'API key'}
        />
        {!tokenOnly && (
          <input className={field} type="password" placeholder="Secret" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Secret" />
        )}
        {!tokenOnly && needsPassphrase && (
          <input className={field} type="password" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} aria-label="Passphrase" />
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={busy || !apiKey.trim() || (!tokenOnly && (!secret.trim() || (needsPassphrase && !passphrase.trim())))}
          onClick={async () => {
            setBusy(true)
            try {
              const ok = await onSave(account.id, {
                apiKey: apiKey.trim(),
                // У токена секрета нет: подпись не строится, ключ передаётся как есть.
                secret: tokenOnly ? apiKey.trim() : secret.trim(),
                passphrase: !tokenOnly && needsPassphrase ? passphrase.trim() : undefined
              })
              if (ok) onClose()
            } finally {
              setBusy(false)
            }
          }}
          className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-bg disabled:opacity-40"
        >
          {busy ? 'Проверяю…' : 'Сохранить и спросить остаток'}
        </button>
        <button onClick={onClose} className="rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-300">
          Отмена
        </button>
      </div>
    </div>
  )
}

/** Счета по группам: банки, брокер, биржи, кошельки, наличные. */
export function AccountList({
  accounts,
  now = Date.now()
}: {
  accounts: FinanceAccount[]
  now?: number
}): React.JSX.Element | null {
  const groups = groupByKind(accounts)
  if (groups.length === 0) return null

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.kind}>
          <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-600">
            {KIND_LABEL[g.kind]}
          </h3>
          <div className="divide-y divide-border">
            {g.items.map((a) => (
              <AccountRow key={a.id} account={a} now={now} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
