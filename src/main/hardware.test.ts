// Разбор дисков на РЕАЛЬНОМ выводе lsblk: строки сняты с живой машины и дополнены
// типовым облачным диском, у которого модели нет вовсе.
import { describe, it, expect } from 'vitest'
import { parseDisks } from './hardware'

const rows = [
  'zram0      8589934592              0 disk',
  'nvme0n1 1024209543168 RS1D0TSSD710 0 disk',
  'vda      42949672960              1 disk', // облачный диск БЕЗ модели — раньше терялся целиком
  'sda     500107862016 Samsung SSD 860 EVO 500GB 0 disk', // модель с пробелами
  'sr0       1073741824              1 rom'
]

describe('parseDisks — вывод lsblk', () => {
  const r = parseDisks(rows)
  const byName = (n: string): (typeof r)[number] | undefined => r.find((d) => d.name === n)

  it('облачный диск без модели не потерян', () => {
    expect(r.some((d) => d.name === 'vda' && d.sizeGb === 43)).toBe(true)
  })

  it('у него нет выдуманной модели', () => {
    expect(byName('vda')?.model).toBeUndefined()
  })

  it('модель с пробелами собрана целиком', () => {
    expect(byName('sda')?.model).toBe('Samsung SSD 860 EVO 500GB')
  })

  it('nvme распознан как SSD', () => {
    expect(byName('nvme0n1')?.ssd).toBe(true)
  })

  it('vda с ROTA=1 помечен как вращающийся', () => {
    expect(byName('vda')?.ssd).toBe(false)
  })

  it('zram отброшен', () => {
    expect(r.some((d) => d.name === 'zram0')).toBe(false)
  })

  it('привод (rom) отброшен', () => {
    expect(r.some((d) => d.name === 'sr0')).toBe(false)
  })

  it('всего 3 диска', () => {
    expect(r).toHaveLength(3)
  })
})
