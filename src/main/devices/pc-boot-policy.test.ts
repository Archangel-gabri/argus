import { describe, expect, it } from 'vitest'
import {
  BOOT_READY_MARKER,
  bootCommandSucceeded,
  bootCommandWasAccepted,
  bootEntryListResult
} from './pc-boot-policy'

describe('подтверждение BootNext', () => {
  it('принимает разрыв только после маркера выставленной записи', () => {
    expect(bootCommandWasAccepted(`${BOOT_READY_MARKER}\n`)).toBe(true)
  })

  it('не считает handshake ECONNRESET успешным boot-switch', () => {
    expect(bootCommandWasAccepted('')).toBe(false)
    expect(bootCommandWasAccepted('grub entry not found')).toBe(false)
  })

  it('после маркера различает ожидаемый разрыв и отказ самой перезагрузки', () => {
    expect(bootCommandSucceeded(false, BOOT_READY_MARKER, 'ECONNRESET')).toBe(true)
    expect(bootCommandSucceeded(false, BOOT_READY_MARKER, 'exit 1')).toBe(false)
    expect(bootCommandSucceeded(true, BOOT_READY_MARKER)).toBe(true)
  })
})

describe('список EFI-записей', () => {
  it('не превращает stderr с exit!=0 в честный пустой список', () => {
    expect(bootEntryListResult(false, 'sudo: a password is required', [], 'exit 1')).toEqual({
      ok: false,
      entries: [],
      error: 'exit 1'
    })
  })

  it('не выдаёт нераспознанный непустой вывод за «записей нет»', () => {
    expect(bootEntryListResult(true, 'localized format changed', [])).toMatchObject({ ok: false, entries: [] })
  })

  it('разрешает фактически разобранную запись', () => {
    const entry = { id: '0002', label: 'Windows Boot Manager' }
    expect(bootEntryListResult(true, 'Boot0002* Windows Boot Manager', [entry])).toEqual({
      ok: true,
      entries: [entry]
    })
  })
})
