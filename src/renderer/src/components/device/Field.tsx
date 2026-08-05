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
  const isNativeControl = (node: ReactNode): node is ReactElement<{ 'aria-labelledby'?: string }> =>
    isValidElement(node) &&
    typeof node.type === 'string' &&
    (node.type === 'input' || node.type === 'select' || node.type === 'textarea')

  // Подпись вешается на ПЕРВЫЙ настоящий контрол, а не только когда ребёнок единственный.
  // Рядом с полем «Операционная система» лежит <datalist> с подсказками — детей становится
  // двое, и подпись доставалась обёртке role="group", а само поле оставалось безымянным для
  // программы чтения с экрана. Слышно это только с включённым экранным диктором, поэтому
  // заметить глазами было нельзя.
  const controlIndex = childList.findIndex(isNativeControl)
  const content =
    controlIndex === -1 ? (
      <div role="group" aria-labelledby={labelId}>
        {children}
      </div>
    ) : (
      childList.map((node, i) =>
        i === controlIndex && isNativeControl(node)
          ? cloneElement(node, { 'aria-labelledby': labelId, key: 'control' })
          : node
      )
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
