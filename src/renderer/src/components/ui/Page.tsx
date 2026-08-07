import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Page({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="h-full overflow-y-auto px-8 py-7">{children}</div>
}

/**
 * Кнопка главного действия экрана.
 *
 * Один вид на всё приложение. Раньше их было три: в финансах — в строке заголовка, в подписках
 * — отдельной полосой ниже, в разделе ИИ — мельче и другой формы. Главное действие приходилось
 * искать заново на каждом экране, хотя это самая частая кнопка.
 */
export function PrimaryAction({
  onClick,
  children,
  secondary
}: {
  onClick: () => void
  children: ReactNode
  /** Второе по важности действие того же экрана: та же форма, но не тянет на себя взгляд. */
  secondary?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={
        secondary
          ? 'flex items-center gap-1.5 rounded-lg bg-card px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-card-hover'
          : 'flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-bold text-bg transition-colors hover:bg-accent-hover'
      }
    >
      {children}
    </button>
  )
}

export function PageHeader({
  title,
  subtitle,
  action
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function Card({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return <div className={cn('rounded-xl border border-border bg-card/60 p-5', className)}>{children}</div>
}

export function StatTile({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  )
}

// Подпись, а не сам ключ: раньше в русский интерфейс печаталось LIVE / MANUAL / SOON — и это
// были два самых контрастных элемента строки подписки.
//
// «своё» вместо «вручную» намеренно: рядом в той же строке стоит бейдж «продлевается руками»,
// и два «вручную» подряд с РАЗНЫМИ смыслами читались как повтор. Здесь речь о происхождении
// записи (завёл человек, а не подтянулось из парка), а не о способе оплаты.
