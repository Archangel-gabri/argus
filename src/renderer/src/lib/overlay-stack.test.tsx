import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { useOverlayA11y, isTopOverlay, openOverlayCount, resetOverlayStack } from './overlay'

// Регрессия на реальный дефект: Escape закрывал ВСЕ открытые overlay сразу. Обработчик висит на
// document в фазе перехвата, и диалог устройства поверх detail-drawer закрывался вместе с ним —
// а вместе с drawer умирала живая SSH-сессия и открытая файловая панель. Человек нажимал Escape,
// чтобы закрыть форму, и терял терминал.
describe('порядок overlay', () => {
  beforeEach(() => resetOverlayStack())

  it('на пустом стеке верхнего нет', () => {
    expect(openOverlayCount()).toBe(0)
    expect(isTopOverlay(Symbol('чужой'))).toBe(false)
  })

  it('Escape достаётся ТОЛЬКО последнему открытому', () => {
    const first = vi.fn()
    const second = vi.fn()
    const ref = createRef<HTMLElement>()

    const lower = renderHook(() => useOverlayA11y({ open: true, onEscape: first, containerRef: ref }))
    const upper = renderHook(() => useOverlayA11y({ open: true, onEscape: second, containerRef: ref }))
    expect(openOverlayCount()).toBe(2)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    upper.unmount()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    // Верхним стал нижний — теперь Escape его.
    expect(first).toHaveBeenCalledTimes(1)

    lower.unmount()
    expect(openOverlayCount()).toBe(0)
  })

  it('закрытый overlay в стек не попадает', () => {
    const ref = createRef<HTMLElement>()
    renderHook(() => useOverlayA11y({ open: false, onEscape: vi.fn(), containerRef: ref }))
    expect(openOverlayCount()).toBe(0)
  })

  it('размонтирование в произвольном порядке не ломает стек', () => {
    const ref = createRef<HTMLElement>()
    const a = renderHook(() => useOverlayA11y({ open: true, onEscape: vi.fn(), containerRef: ref }))
    const b = renderHook(() => useOverlayA11y({ open: true, onEscape: vi.fn(), containerRef: ref }))
    // Нижний закрылся первым — стек не должен «залипнуть».
    a.unmount()
    expect(openOverlayCount()).toBe(1)
    b.unmount()
    expect(openOverlayCount()).toBe(0)
  })
})
