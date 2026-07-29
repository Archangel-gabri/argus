import { useId, useState, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

// Кружок «?» с всплывающим объяснением.
//
// Зачем свой компонент вместо нативного `title`. До этого все подсказки в форме устройства
// висели на атрибуте `title`, и получалось три проблемы сразу: плашку рисует операционная
// система — мимо палитры приложения; она появляется с задержкой около секунды, то есть
// пользователь успевает решить, что подсказки нет; и она недоступна с клавиатуры, потому что
// `title` показывается только по наведению мыши.
//
// Смысл этого компонента шире оформления: он позволил вынести из интерфейса длинные абзацы.
// Объяснение остаётся доступным, но не занимает экран постоянно — а именно постоянные абзацы
// делали приложение похожим на инструкцию.
export function Hint({
  children,
  side = 'right',
  className
}: {
  children: ReactNode
  /** С какой стороны раскрывать. У правого края формы попап уходил бы за пределы окна. */
  side?: 'left' | 'right'
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <span className={cn('relative inline-flex', className)}>
      <span
        // Кружок именно такой, как был у прежних подсказок: форма устройства не должна
        // визуально переехать из-за смены механики.
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full text-[10px] font-bold text-slate-500 ring-1 ring-border hover:text-slate-300 hover:ring-slate-500"
        // Открываем и по наведению, и по фокусу: с клавиатуры подсказка тоже должна работать.
        tabIndex={0}
        role="button"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-label="Подсказка"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
      >
        ?
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          // z-[70] — выше выдвижной панели (z-50) и палитры команд (z-[60]): иначе подсказка
          // внутри панели уезжает под её же подложку.
          className={cn(
            'pointer-events-none absolute top-5 z-[70] w-max max-w-[260px] rounded-lg border border-border',
            'bg-surface px-2.5 py-1.5 text-[11px] font-normal normal-case leading-relaxed tracking-normal',
            'text-slate-300 shadow-xl',
            // Без анимации появления сознательно: плагина анимаций в проекте нет, а подсказка
            // должна возникать сразу — задержка была одной из причин отказаться от `title`.
            side === 'right' ? 'left-0' : 'right-0'
          )}
        >
          {children}
        </span>
      )}
    </span>
  )
}
