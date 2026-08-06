import { useEffect, useRef, type RefObject } from 'react'

type FocusHandle = {
  focus: () => void
  isConnected?: boolean
}

export type OverlayDismissReason = 'backdrop' | 'escape' | 'button'

/** Клик по подложке не должен уничтожать уже заполненную форму. */
export function shouldDismissOverlay(reason: OverlayDismissReason, dirty = false): boolean {
  return reason !== 'backdrop' || !dirty
}

export function focusElement(target: FocusHandle | null | undefined): boolean {
  if (!target) return false
  target.focus()
  return true
}

export function restoreFocus(target: FocusHandle | null | undefined): boolean {
  if (!target || target.isConnected === false) return false
  target.focus()
  return true
}

/**
 * Стек открытых overlay.
 *
 * Обработчик Escape вешается на document в фазе перехвата, и раньше срабатывали ВСЕ открытые
 * сразу: диалог устройства поверх detail-drawer закрывался вместе с ним, а вместе с drawer
 * умирала живая SSH-сессия и открытая файловая панель. Человек нажимал Escape, чтобы закрыть
 * форму, и терял терминал.
 *
 * Escape по смыслу закрывает ВЕРХНИЙ слой, поэтому здесь ведётся порядок открытия, а нижние
 * молча пропускают событие.
 */
const overlayStack: symbol[] = []

/** Верхний ли этот overlay — только он реагирует на Escape. */
export const isTopOverlay = (token: symbol): boolean => overlayStack[overlayStack.length - 1] === token

/** Для проверок: сколько overlay открыто прямо сейчас. */
export const openOverlayCount = (): number => overlayStack.length

/** Для проверок: начать с чистого листа. */
export const resetOverlayStack = (): void => {
  overlayStack.length = 0
}

const FOCUSABLE = [
  '[autofocus]',
  'button:not([disabled]):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

/**
 * Механика overlay без новой UI-библиотеки: начальный фокус, Escape, возврат фокуса в кнопку,
 * которая открыла окно, и удержание фокуса внутри.
 *
 * Удержание обязательно, и вот почему. Подложка закрывает экран, но не убирает из обхода то,
 * что под ней: с последнего поля формы Tab уходил дальше по разметке и попадал на боковую
 * панель — невидимую, под затемнением. Там живёт кнопка «Закрыть хранилище»: человек, идущий
 * по форме с клавиатуры, мог запереть хранилище, не понимая, куда делся фокус.
 */
export function useOverlayA11y({
  open,
  onEscape,
  containerRef,
  initialFocusRef
}: {
  open: boolean
  onEscape: () => void
  containerRef: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
}): void {
  const previousFocus = useRef<HTMLElement | null>(null)
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!open) return
    const token = Symbol('overlay')
    overlayStack.push(token)
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Effect идёт после commit: refs уже привязаны, отложенный frame не нужен.
    const target = initialFocusRef?.current ?? containerRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    focusElement(target)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Нижние слои молчат: закрывать надо тот, что сверху.
      if (!isTopOverlay(token)) return
      event.preventDefault()
      event.stopPropagation()
      // Останавливаем и остальных слушателей того же узла: иначе соседний overlay,
      // подписавшийся раньше, всё равно получит событие.
      event.stopImmediatePropagation()
      onEscapeRef.current()
    }
    // Tab по кругу внутри окна. Слушаем на всплытии и только у верхнего слоя: нижние окна
    // своим обработчиком перехватили бы чужой Tab.
    const onTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !isTopOverlay(token)) return
      const box = containerRef.current
      if (!box) return
      // Без фильтра по видимости: `offsetParent` требует раскладки, которой нет ни в jsdom, ни
      // у элемента с `position: fixed`, — проверка молча оставляла список пустым, и ловушка не
      // срабатывала вовсе. Сам селектор уже отсекает отключённое и выведенное из обхода.
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      // Фокус мог оказаться вне окна (например, после клика по подложке) — возвращаем его.
      if (!(active instanceof HTMLElement) || !box.contains(active)) {
        event.preventDefault()
        focusElement(event.shiftKey ? last : first)
        return
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        focusElement(first)
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        focusElement(last)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keydown', onTab)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keydown', onTab)
      const at = overlayStack.lastIndexOf(token)
      if (at !== -1) overlayStack.splice(at, 1)
      restoreFocus(previousFocus.current)
      previousFocus.current = null
    }
  }, [open, containerRef, initialFocusRef])
}
