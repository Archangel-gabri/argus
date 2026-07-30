import { describe, expect, it } from 'vitest'
import { METRIC_SNAPSHOT_INSERT, snapshotStatus, snapshotValues } from './metric-snapshot'

describe('запись снимка метрик', () => {
  it('проводит занятость диска в отдельную SQL-колонку', () => {
    expect(METRIC_SNAPSHOT_INSERT).toContain('ram_total, disk, status')
    expect(
      snapshotValues('node-1', 123, {
        cpu: 7,
        ramUsed: 2,
        ramTotal: 8,
        disk: 91,
        status: 'online'
      })
    ).toEqual(['node-1', 123, 7, 2, 8, 91, 'online'])
  })

  it('не превращает отсутствующие метрики в измеренные нули', () => {
    expect(snapshotValues('node-1', 123, { status: 'offline' })).toEqual([
      'node-1',
      123,
      null,
      null,
      null,
      null,
      'offline'
    ])
  })

  it('нормализует семейство ОС, не путая его со выключением', () => {
    expect(snapshotStatus('windows')).toBe('online')
    expect(snapshotStatus('linux')).toBe('online')
    expect(snapshotStatus('off')).toBe('offline')
    expect(snapshotStatus('unknown')).toBe('unknown')
  })
})
