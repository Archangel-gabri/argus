import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { ProviderMark } from '@/components/ai/ProviderMark'
import { UsageBars } from '@/components/ai/UsageBars'
import { daysUntilExpiry, monthlyCost } from '@/lib/ai-account'
import type { AiAccess, AiCheck, Subscription } from '@/types'

/**
 * Состояние доступа одной точкой.
 *
 * Точка молчит, когда всё в порядке: строка не должна кричать зелёным о том, что и так норма.
 * Цветом отмечается только то, что требует действия.
 */
function StatusDot({ tone, title }: { tone: 'ok' | 'warn' | 'dead' | 'idle'; title: string }): React.JSX.Element {
  const cls =
    tone === 'dead'
      ? 'bg-rose-500'
      : tone === 'warn'
        ? 'bg-amber-400'
        : tone === 'idle'
          ? 'bg-slate-600'
          : 'bg-emerald-500/70'
  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cls)} title={title} />
}

export interface RowState {
  tone: 'ok' | 'warn' | 'dead' | 'idle'
  title: string
}

/** Во что превращается совокупность признаков доступа. Отдельно от разметки — это правило, не вид. */
export function rowState(access: AiAccess, check: AiCheck | undefined, now = Date.now()): RowState {
  if (access.status === 'planned') return { tone: 'idle', title: 'Не оформлен' }
  if (access.status === 'expired') return { tone: 'dead', title: 'Истёк' }
  if (check?.status === 'invalid') return { tone: 'dead', title: 'Ключ не принимается' }
  const days = daysUntilExpiry(access.keyExpiresAt, now)
  if (days !== null && days <= 14) return { tone: 'warn', title: days < 0 ? 'Ключ истёк' : `Ключу осталось ${days} дн.` }
  if (typeof check?.remaining === 'number' && check.remaining <= 5)
    return { tone: 'warn', title: `Остаток ${money(check.remaining)}` }
  if (access.status === 'paused') return { tone: 'idle', title: 'На паузе' }
  return { tone: 'ok', title: 'В работе' }
}

/**
 * Правая колонка строки — деньги. Показывается ОДИН факт, самый важный для этого типа доступа:
 * у подписки цена, у пополняемого счёта остаток, у бесплатного — ничего. Пустых ячеек «—» нет:
 * прочерк занимает место и ничего не сообщает.
 */
function moneyCell(access: AiAccess, sub: Subscription | undefined, check: AiCheck | undefined): React.JSX.Element | null {
  if (sub) {
    const monthly = monthlyCost(sub)
    return (
      <span className="tabular-nums text-slate-200">
        {money(sub.amount, sub.currency)}
        <span className="text-slate-600">/{sub.period === 'yr' ? 'год' : 'мес'}</span>
        {sub.period === 'yr' && monthly != null && (
          <span className="ml-1 text-[10px] text-slate-600">≈{money(Math.round(monthly), sub.currency)}/мес</span>
        )}
      </span>
    )
  }
  if (typeof check?.remaining === 'number')
    return (
      <span className={cn('tabular-nums', check.remaining <= 5 ? 'text-amber-400' : 'text-slate-300')}>
        {money(check.remaining)} <span className="text-[10px] text-slate-600">остаток</span>
      </span>
    )
  if (access.payment === 'free') return <span className="text-slate-600">бесплатно</span>
  if (access.status === 'planned') return <span className="text-slate-600">не оформлен</span>
  return null
}

export function AccessRow({
  access,
  check,
  sub,
  series,
  spent,
  selected,
  onSelect
}: {
  access: AiAccess
  check?: AiCheck
  sub?: Subscription
  /** Расход по дням за период — лента справа. */
  series: number[]
  /** Сумма за период, для подсказки. */
  spent: number
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const state = rowState(access, check)
  const cell = moneyCell(access, sub, check)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={cn(
        'group grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-l-2 px-3 py-2 text-left transition-colors',
        selected
          ? 'border-l-accent bg-card'
          : 'border-l-transparent hover:border-l-border hover:bg-card/50'
      )}
    >
      <ProviderMark
        provider={access.provider}
        label={access.label}
        size={18}
        className={cn('transition-colors', selected ? 'text-slate-200' : 'text-slate-400 group-hover:text-slate-300')}
      />

      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className={cn('truncate text-[13px] font-medium', selected ? 'text-white' : 'text-slate-200')}>
            {access.label}
          </span>
          {access.thirdParty && (
            <span title="Запросы идут через посредника" className="flex shrink-0">
              <ShieldAlert className="h-3 w-3 text-amber-500/80" />
            </span>
          )}
          {state.tone !== 'ok' && state.tone !== 'idle' && (
            <span title={state.title} className="flex shrink-0">
              <AlertTriangle className="h-3 w-3 text-amber-400" />
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-slate-600">
          {access.account || access.plan || access.provider}
        </span>
      </span>

      <span className="whitespace-nowrap text-right text-[11px]">{cell}</span>

      <span className="flex w-[120px] items-center justify-end gap-2">
        {series.length > 0 && spent > 0 && (
          <UsageBars data={series} width={100} height={18} title={`Расход за период: ${money(Math.round(spent))}`} />
        )}
        <StatusDot tone={state.tone} title={state.title} />
      </span>
    </button>
  )
}
