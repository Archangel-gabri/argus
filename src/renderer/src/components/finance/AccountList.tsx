import { useEffect, useState } from 'react'
import { Check, Coins, KeyRound, LogIn, Pencil, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { KIND_LABEL, balanceAge, groupByKind } from '@/lib/finance'
import { useAccounts } from '@/store/accounts'
import type { FinanceAccount } from '@/types'
import { bankOf, type BankId } from '../../../../shared/banks'
import { BrandMark } from '@/components/BrandMark'

/**
 * Строка счёта.
 *
 * Остаток здесь правится на месте, а не в отдельной форме: у российских банков API нет, вписывать
 * цифру придётся регулярно, и каждый лишний шаг между «увидел в приложении банка» и «внёс сюда»
 * — это шаг, после которого цифру не внесут вовсе.
 */
function AccountRow({
  account,
  now,
  onEdit
}: {
  account: FinanceAccount
  now: number
  onEdit?: (a: FinanceAccount) => void
}): React.JSX.Element {
  const update = useAccounts((s) => s.update)
  const remove = useAccounts((s) => s.remove)
  const setCreds = useAccounts((s) => s.setCreds)
  const bankLogin = useAccounts((s) => s.bankLogin)
  const bankSessions = useAccounts((s) => s.bankSessions)
  const issue = useAccounts((s) => s.balanceIssues[account.id])
  const [editing, setEditing] = useState(false)
  const [keys, setKeys] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState<string | null>(null)

  // Банк, чей остаток читается из сессии кабинета: у него вместо ключа — вход.
  // Вход в кабинет доступен ЛЮБОМУ счёту, опознанному как банк. Раньше он показывался только
  // при `source === 'api'` — то есть счёту, остаток которого УЖЕ читается из сессии. Замкнутый
  // круг: чтобы появилась кнопка входа, надо было сперва войти. У счёта, заведённого руками,
  // источник всегда `manual`, и кнопки не было вовсе — а именно так владелец счета и заводит.
  // Источник говорит, откуда взялась цифра, а не о том, можно ли открыть кабинет.
  const bank = bankOf(account)
  // Возраст показывается и у автоматических: если опрос перестал получаться, цифра стареет
  // молча, и «обновляется само» превращается в неправду.
  const age = balanceAge(account.balanceAt, now)

  const save = async (): Promise<void> => {
    const raw = draft.trim().replace(/\s/g, '').replace(',', '.')
    const value = raw === '' ? null : Number(raw)
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      // Раньше здесь стоял голый `return`: ни сообщения, ни подсветки — Enter будто ничего не
      // делает, и человек не понимает, что не так с введённым.
      setInvalid(`Не понимаю «${draft.trim()}» — нужно неотрицательное число`)
      return
    }
    setInvalid(null)
    setBusy(true)
    try {
      // Время замера ставит хранилище — и только когда цифра действительно изменилась.
      // Ручная правка снимает признак «обновляется само»: цифру внёс человек, и подписывать
      // её «по сессии кабинета» было бы неправдой.
      if (await update(account.id, { name: account.name, balance: value, source: 'manual' }))
        setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    {invalid && (
      <p role="alert" className="pl-11 text-[11px] text-rose-400">
        {invalid}
      </p>
    )}
    <div className="group flex items-center gap-3 py-2.5 text-sm">
      {/* Знак наследует цвет текста и остаётся приглушённым — как в разделе ИИ. Фирменные цвета
          в списке спорили друг с другом: зелёный Сбер, жёлтый Т-Банк и синий PayPal в одном
          столбце читались как СТАТУСЫ («у этого что-то не так»), хотя означали только бренд.
          Цвет в приложении занят делом — им подписаны состояния. */}
      {/* Знак — тот же компонент, что в парке и подписках. Пока их было три, у сервера в
          парке логотип был, а у платежа за него в подписках нет. */}
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] text-slate-400">
        <BrandMark name={`${account.institution} ${account.name}`} size={17} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-slate-200">{account.name}</span>
          {/* Бейдж говорил «по ключу» и банку тоже — а у российского банка ключа не бывает
              вовсе, его остаток читается из сессии кабинета. В одной строке уживались два
              разных утверждения о происхождении цифры: бейдж «по ключу» сверху и подпись «по
              сессии кабинета» снизу. Оставляем подпись под суммой: она уже отвечает на это. */}
          {account.source === 'api' && !bank && (
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
              className="rounded p-1.5 text-emerald-400 hover:bg-white/5"
              aria-label="Сохранить остаток"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded p-1.5 text-slate-500 hover:text-slate-300"
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
                issue ? 'text-amber-400' : age?.level === 'stale' ? 'text-amber-400/80' : 'text-slate-400'
              )}
            >
              {/* Причина, по которой остаток не обновился, важнее его возраста: пока её не
                  показывали, строка неделями обещала «обновляется само», а цифра стояла на
                  месте, и понять почему было нельзя. */}
              {issue
                ? issue
                : age && age.level !== 'fresh'
                ? account.source === 'api'
                  ? `обновлено ${age.days} дн. назад`
                  : `вписано ${age.days} дн. назад`
                : account.source === 'api'
                  ? // У банка сессия живёт минуты, и обещать «обновляется само» нельзя: цифра
                    // свежа ровно пока владелец недавно заходил.
                    bank
                    ? 'по сессии кабинета'
                    : 'обновляется само'
                    : ''}
            </div>
          </button>
        )}
      </div>

      {/* Вход в кабинет — единственный способ обновить остаток у российского банка, и прятать
          его до наведения значит прятать саму возможность: владелец не подозревал, что она есть.
          Кнопка видна всегда, а её вид говорит, вошли уже или нет. */}
      {bank && (
        <button
          onClick={() => void bankLogin(bank)}
          className={cn(
            'mr-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium',
            bankSessions[bank]
              ? 'text-emerald-400/80 hover:bg-emerald-500/10'
              : 'bg-slate-800/60 text-slate-300 hover:bg-slate-700/60'
          )}
          aria-label={bankSessions[bank] ? `Обновить остаток ${account.name}` : `Войти в ${account.name}`}
          title={
            bankSessions[bank]
              ? 'Вход в кабинет есть — остаток читается из сессии'
              : 'Войти в кабинет банка — окно откроется внутри Argus'
          }
        >
          <LogIn className="h-3.5 w-3.5" />
          {bankSessions[bank] ? 'вход есть' : 'войти'}
        </button>
      )}

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {(account.kind === 'exchange' || account.kind === 'broker') && (
          <button
            onClick={() => setKeys((v) => !v)}
            className={cn('rounded p-1.5 hover:text-accent', account.hasCreds ? 'text-emerald-400/80' : 'text-slate-500')}
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
          className="rounded p-1.5 text-slate-500 hover:text-accent"
          aria-label={`Изменить остаток ${account.name}`}
          title="Вписать остаток"
        >
          <Coins className="h-3.5 w-3.5" />
        </button>
        {/* Правка самих полей счёта. Раньше карандаш открывал только ввод остатка, и опечатку
            в названии или ошибочно выбранную валюту исправить было нечем: оставалось удалить
            счёт и завести заново, а удаление счёта биржи заодно стирает сохранённые ключи. */}
        <button
          onClick={() => onEdit?.(account)}
          className="rounded p-1.5 text-slate-500 hover:text-accent"
          aria-label={`Изменить счёт ${account.name}`}
          title="Изменить название, тип, валюту"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => {
            // Счёт заводится руками и восстановлению не подлежит — спрашиваем, как и везде.
            if (window.confirm(`Удалить счёт «${account.name}»? Отменить будет нельзя.`))
              void remove(account.id)
          }}
          className="rounded p-1.5 text-slate-500 hover:text-rose-400"
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
  now = Date.now(),
  onEdit
}: {
  accounts: FinanceAccount[]
  now?: number
  /** Открыть форму правки полей счёта. Без неё карандаш в строке нечем обслужить. */
  onEdit?: (a: FinanceAccount) => void
}): React.JSX.Element | null {
  const groups = groupByKind(accounts)
  const checkBankSessions = useAccounts((s) => s.checkBankSessions)
  // Спрашиваем один раз на состав списка: проверка читает свою же куку и в сеть не ходит,
  // а знание «вход есть» меняет подпись кнопки у каждой строки банка.
  // Спрашиваем про ВСЕ опознанные банки, а не только про те, чей остаток уже читается по
  // сессии. Прежний фильтр повторял ту же ошибку, что и кнопка входа: узнать про вход можно
  // было только у того, кто уже вошёл.
  const bankIds = accounts.map((a) => bankOf(a)).filter((b): b is BankId => Boolean(b))
  const bankKey = bankIds.join(',')
  useEffect(() => {
    if (bankKey) void checkBankSessions(bankKey.split(','))
  }, [bankKey, checkBankSessions])

  if (groups.length === 0) return null

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.kind}>
          <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
            {KIND_LABEL[g.kind]}
          </h3>
          <div className="divide-y divide-border">
            {g.items.map((a) => (
              <AccountRow key={a.id} account={a} now={now} onEdit={onEdit} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
