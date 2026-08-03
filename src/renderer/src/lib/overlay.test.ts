import { describe, expect, it, vi } from 'vitest'
import { focusElement, restoreFocus, shouldDismissOverlay } from './overlay'

describe('overlay accessibility helpers', () => {
  it('does not discard a dirty form through an accidental backdrop click', () => {
    expect(shouldDismissOverlay('backdrop', true)).toBe(false)
    expect(shouldDismissOverlay('backdrop', false)).toBe(true)
    expect(shouldDismissOverlay('escape', true)).toBe(true)
  })

  it('focuses the requested initial control', () => {
    const focus = vi.fn()
    expect(focusElement({ focus })).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    expect(focusElement(null)).toBe(false)
  })

  it('restores focus only while the opener is still connected', () => {
    const focus = vi.fn()
    expect(restoreFocus({ focus, isConnected: true })).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    expect(restoreFocus({ focus, isConnected: false })).toBe(false)
    expect(focus).toHaveBeenCalledOnce()
  })
})

