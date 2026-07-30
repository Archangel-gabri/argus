import { describe, expect, it } from 'vitest'
import { beginAccess, isAccessCurrent, revokePendingAccess } from './access-epoch'

describe('гонка открытия доступа с блокировкой', () => {
  it('инвалидирует все операции, начатые до lock, но разрешает новые после unlock', () => {
    const beforeLockA = beginAccess()
    const beforeLockB = beginAccess()
    expect(isAccessCurrent(beforeLockA)).toBe(true)

    revokePendingAccess()

    expect(isAccessCurrent(beforeLockA)).toBe(false)
    expect(isAccessCurrent(beforeLockB)).toBe(false)
    expect(isAccessCurrent(beginAccess())).toBe(true)
  })
})
