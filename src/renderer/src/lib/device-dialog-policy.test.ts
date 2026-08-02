import { describe, expect, it } from 'vitest'
import { assignBootEntry, selectedBootEntry, probesWithStoredSecret } from './device-dialog-policy'

describe('назначение загрузочной записи', () => {
  const fields = {
    bootEntry: '0001',
    altOs: [
      { os: 'Windows 11', bootEntry: '' },
      { os: 'Rescue', bootEntry: '0003' }
    ]
  }

  it('назначает запись основной ОС', () => {
    expect(assignBootEntry(fields, 'primary', '0009').bootEntry).toBe('0009')
  })

  it('назначает запись целевой alt OS, не подменяя primary', () => {
    const next = assignBootEntry(fields, 'alt:0', '{windows-guid}')
    expect(next.bootEntry).toBe('0001')
    expect(next.altOs[0].bootEntry).toBe('{windows-guid}')
    expect(selectedBootEntry(next, 'alt:0')).toBe('{windows-guid}')
  })
})

describe('повторная SSH-проба', () => {
  it('использует сохранённый main-only secret при пустых edit-полях', () => {
    expect(probesWithStoredSecret(true, true, '', '')).toBe(true)
  })

  it('проверяет новый ввод явно и не подменяет его старым секретом', () => {
    expect(probesWithStoredSecret(true, true, 'new password', '')).toBe(false)
    expect(probesWithStoredSecret(true, true, '', 'new key')).toBe(false)
    expect(probesWithStoredSecret(false, true, '', '')).toBe(false)
    expect(probesWithStoredSecret(true, false, '', '')).toBe(false)
  })
})
