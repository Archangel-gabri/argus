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
 * Минимальная механика overlay без новой UI-библиотеки: начальный фокус, Escape и возврат
 * фокуса в кнопку, которая открыла окно. Focus trap сознательно не изображаем вручную.
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
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Effect идёт после commit: refs уже привязаны, отложенный frame не нужен.
    const target = initialFocusRef?.current ?? containerRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    focusElement(target)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onEscapeRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      restoreFocus(previousFocus.current)
      previousFocus.current = null
    }
  }, [open, containerRef, initialFocusRef])
}
