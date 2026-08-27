import { describe, it, expect, vi } from 'vitest'
import { isDuplicateColumnError, addColumn } from './migrate-guard'

// Регрессия на реальный дефект: каждый из одиннадцати ALTER-ов был обёрнут голым `catch {}`
// с комментарием «колонка уже есть». SQLite отдаёт один и тот же код SQLITE_ERROR и на дубль
// колонки, и на повреждённую базу, и на кончившийся диск — значит молча проглатывалось всё.
describe('isDuplicateColumnError', () => {
  it('узнаёт ожидаемую ошибку', () => {
    expect(isDuplicateColumnError(new Error('duplicate column name: jump_id'))).toBe(true)
    expect(isDuplicateColumnError(new Error('SQLITE_ERROR: duplicate column name: kind'))).toBe(true)
  })

  it('НЕ принимает за неё настоящие поломки', () => {
    for (const msg of [
      'no such table: devices',
      'database disk image is malformed',
      'disk I/O error',
      'database or disk is full',
      'attempt to write a readonly database',
      'file is not a database'
    ]) {
      expect(isDuplicateColumnError(new Error(msg))).toBe(false)
    }
  })

  it('не спотыкается на том, что брошено не как Error', () => {
    expect(isDuplicateColumnError('duplicate column name: x')).toBe(true)
    expect(isDuplicateColumnError(null)).toBe(false)
    expect(isDuplicateColumnError(undefined)).toBe(false)
  })
})

describe('addColumn', () => {
  it('на чистой базе колонку добавляет', () => {
    const exec = vi.fn()
    expect(addColumn(exec, 'ALTER TABLE devices ADD COLUMN mac TEXT')).toBe(true)
    expect(exec).toHaveBeenCalledWith('ALTER TABLE devices ADD COLUMN mac TEXT')
  })

  it('на уже мигрированной — молча пропускает', () => {
    const exec = vi.fn(() => {
      throw new Error('duplicate column name: mac')
    })
    expect(addColumn(exec, 'ALTER TABLE devices ADD COLUMN mac TEXT')).toBe(false)
  })

  it('настоящую поломку ПРОБРАСЫВАЕТ, а не выдаёт за «уже мигрировано»', () => {
    const exec = vi.fn(() => {
      throw new Error('database or disk is full')
    })
    expect(() => addColumn(exec, 'ALTER TABLE devices ADD COLUMN mac TEXT')).toThrow(/disk is full/)
  })

  it('в сообщении видно, какая именно миграция упала', () => {
    const exec = vi.fn(() => {
      throw new Error('database disk image is malformed')
    })
    // Иначе поломка всплывёт позже и в другом месте, где её уже не связать с причиной.
    expect(() => addColumn(exec, 'ALTER TABLE subscriptions ADD COLUMN manual_renewal INTEGER')).toThrow(
      /subscriptions ADD COLUMN manual_renewal/
    )
  })

  it('сохраняет исходную ошибку причиной', () => {
    const original = new Error('disk I/O error')
    const exec = vi.fn(() => {
      throw original
    })
    try {
      addColumn(exec, 'ALTER TABLE devices ADD COLUMN icon TEXT')
      expect.unreachable('должно было выбросить')
    } catch (e) {
      expect((e as Error).cause).toBe(original)
    }
  })
})
