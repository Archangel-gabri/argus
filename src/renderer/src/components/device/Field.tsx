import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Hint } from '@/components/ui/Hint'

/**
 * Поле формы. hint — короткое объяснение: кружок «?» в правом углу подписи, подсказка по
 * наведению. Без него половину полей приходилось угадывать (что такое jump-host, зачем MAC,
 * чем «роль» отличается от имени).
 */
export function Field({
  label,
  hint,
  full,
  children
}: {
  label: string
  hint?: string
  full?: boolean
  children: ReactNode
}): React.JSX.Element {
  const labelId = useId()
  const childList = Children.toArray(children)
  const child = childList.length === 1 ? childList[0] : null
  const isNativeControl =
    isValidElement(child) &&
    typeof child.type === 'string' &&
    (child.type === 'input' || child.type === 'select' || child.type === 'textarea')
  const content = isNativeControl
    ? cloneElement(child as ReactElement<{ 'aria-labelledby'?: string }>, { 'aria-labelledby': labelId })
    : (
        <div role="group" aria-labelledby={labelId}>
          {children}
        </div>
      )

  return (
    <div className={cn('block', full && 'col-span-2')}>
      <span className="mb-1 flex items-center justify-between gap-2">
        <span id={labelId} className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {label}
        </span>
        {/* Подсказка через свой компонент, а не через атрибут `title`: тот рисуется системой
            мимо палитры, появляется с задержкой около секунды и не открывается с клавиатуры. */}
        {hint && <Hint side="left" label={`Подсказка: ${label}`}>{hint}</Hint>}
      </span>
      {content}
    </div>
  )
}
