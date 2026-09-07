import { beforeEach, describe, expect, it, vi } from 'vitest'

let lifetime: typeof import('./session-lifetime')
beforeEach(async () => {
  vi.resetModules()
  lifetime = await import('./session-lifetime')
})

describe('renderer session lifetime', () => {
  it('starts inactive and cannot mint a valid request for the locked renderer', () => {
    expect(lifetime.captureSession()).toBeNull()
    expect(lifetime.isSessionCurrent(null)).toBe(false)
  })
  it('allows requests after acknowledged activation', () => {
    lifetime.activateSession()
    const ticket = lifetime.captureSession()
    expect(ticket).not.toBeNull()
    expect(lifetime.isSessionCurrent(ticket)).toBe(true)
  })
  it('invalidates synchronously and never revives an old ticket after reactivation', () => {
    lifetime.activateSession()
    const old = lifetime.captureSession()
    lifetime.invalidateSession()
    expect(lifetime.isSessionCurrent(old)).toBe(false)
    expect(lifetime.captureSession()).toBeNull()
    lifetime.activateSession()
    expect(lifetime.isSessionCurrent(old)).toBe(false)
    expect(lifetime.isSessionCurrent(lifetime.captureSession())).toBe(true)
  })
  it('does not revoke live requests for a redundant unlocked-state refresh', () => {
    lifetime.activateSession()
    const ticket = lifetime.captureSession()
    lifetime.activateSession()
    expect(lifetime.captureSession()).toBe(ticket)
    expect(lifetime.isSessionCurrent(ticket)).toBe(true)
  })
  it('survives repeated concealment without manufacturing a live session', () => {
    lifetime.activateSession()
    const ticket = lifetime.captureSession()
    lifetime.invalidateSession()
    lifetime.invalidateSession()
    expect(lifetime.captureSession()).toBeNull()
    expect(lifetime.isSessionCurrent(ticket)).toBe(false)
  })
})
