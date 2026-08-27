import { describe, it, expect } from 'vitest'
import { parseProbeV2 } from './metrics'

// Первые тесты на `metrics.ts` — 14 КБ разборщика, у которого их не было вовсе, при том что
// родственный `metrics-bsd.ts` покрыт двадцатью двумя.
//
// Отправная точка — реальный дефект: `diskIoAvailable` выставлялся в `true` безусловно, поэтому
// машина, на которой физических дисков в /proc/diskstats не нашлось (LVM `dm-0`, софт-рейд
// `md0`, контейнер без секции), показывала «0 Б/с» вместо «недоступно». Отсутствие данных
// выглядело как факт простоя, а это разные вещи.

const SAMPLE_SEC = 0.7

/** Собрать вывод зонда из секций — ровно в той форме, в какой его отдаёт LINUX_PROBE_V2. */
function probe(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([name, body]) => `@@${name}\n${body}`)
    .join('\n')
}

const CPU_1 = 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0'
const CPU_2 = 'cpu  110 0 110 980 0 0 0 0 0 0\ncpu0 55 0 55 490 0 0 0 0 0 0\ncpu1 55 0 55 490 0 0 0 0 0 0'
const MEM = [
  'MemTotal:       16000000 kB',
  'MemAvailable:    8000000 kB',
  'Buffers:          200000 kB',
  'Cached:          1000000 kB',
  'SReclaimable:     100000 kB',
  'SwapTotal:       2000000 kB',
  'SwapFree:        2000000 kB'
].join('\n')

/** Строка /proc/diskstats: поле 3 — имя, 6 — секторов прочитано, 10 — записано. */
const diskLine = (name: string, readSectors: number, writeSectors: number): string =>
  `   8       0 ${name} 100 0 ${readSectors} 50 200 0 ${writeSectors} 90 0 120 140`

const base = {
  LOAD: '0.50 0.40 0.30 1/500 12345',
  MEM,
  MOUNTS: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 40000000 60000000 40% /'
}

describe('parseProbeV2 — доступность дисковых показаний', () => {
  it('нашёл физические диски → показания измерены', () => {
    const out = parseProbeV2(
      probe({
        S1: CPU_1,
        N1: '',
        D1: diskLine('sda', 1000, 2000),
        S2: CPU_2,
        N2: '',
        D2: diskLine('sda', 1000 + 700, 2000 + 1400),
        ...base
      })
    )
    expect(out.diskIoAvailable).toBe(true)
    // 700 секторов × 512 байт за 0.7с = 512000 Б/с.
    expect(out.diskR).toBe(Math.round((700 * 512) / SAMPLE_SEC))
    expect(out.diskW).toBe(Math.round((1400 * 512) / SAMPLE_SEC))
  })

  it('диски нашлись, но не двигались → это ЧЕСТНЫЙ ноль', () => {
    const line = diskLine('nvme0n1', 5000, 5000)
    const out = parseProbeV2(probe({ S1: CPU_1, N1: '', D1: line, S2: CPU_2, N2: '', D2: line, ...base }))
    expect(out.diskIoAvailable).toBe(true)
    expect(out.diskR).toBe(0)
    expect(out.diskW).toBe(0)
  })

  it('только LVM — измерять было нечего, и это НЕ ноль', () => {
    // Именно этот случай раньше выдавался за измеренный простой.
    const line = diskLine('dm-0', 9000, 9000)
    const out = parseProbeV2(probe({ S1: CPU_1, N1: '', D1: line, S2: CPU_2, N2: '', D2: line, ...base }))
    expect(out.diskIoAvailable).toBe(false)
  })

  it('только софт-рейд — тоже «не знаю»', () => {
    const line = diskLine('md0', 9000, 9000)
    const out = parseProbeV2(probe({ S1: CPU_1, N1: '', D1: line, S2: CPU_2, N2: '', D2: line, ...base }))
    expect(out.diskIoAvailable).toBe(false)
  })

  it('пустая секция diskstats — «не знаю»', () => {
    const out = parseProbeV2(probe({ S1: CPU_1, N1: '', D1: '', S2: CPU_2, N2: '', D2: '', ...base }))
    expect(out.diskIoAvailable).toBe(false)
  })

  it('секции diskstats нет вовсе — «не знаю», и разбор не падает', () => {
    const out = parseProbeV2(probe({ S1: CPU_1, N1: '', S2: CPU_2, N2: '', ...base }))
    expect(out.diskIoAvailable).toBe(false)
    expect(out.cpu).toBeGreaterThanOrEqual(0)
  })
})

describe('parseProbeV2 — загрузка процессора', () => {
  it('считается по дельте двух замеров и лежит в разумных пределах', () => {
    const out = parseProbeV2(
      probe({ S1: CPU_1, N1: '', D1: diskLine('sda', 0, 0), S2: CPU_2, N2: '', D2: diskLine('sda', 0, 0), ...base })
    )
    // Между замерами: занято 10+10=20 тиков, простой 180, всего 200 → 10%.
    expect(out.cpu).toBeCloseTo(10, 0)
    expect(out.cpu).toBeGreaterThanOrEqual(0)
    expect(out.cpu).toBeLessThanOrEqual(100)
    expect(out.cores).toHaveLength(2)
    for (const c of out.cores) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(100)
    }
  })

  it('одинаковые замеры дают ноль, а не деление на ноль', () => {
    const out = parseProbeV2(
      probe({ S1: CPU_1, N1: '', D1: diskLine('sda', 0, 0), S2: CPU_1, N2: '', D2: diskLine('sda', 0, 0), ...base })
    )
    expect(Number.isFinite(out.cpu)).toBe(true)
    expect(out.cpu).toBe(0)
  })
})

describe('parseProbeV2 — устойчивость', () => {
  it('не бросает ни на пустом вводе, ни на мусоре', () => {
    for (const bad of ['', '   ', 'совершенно посторонний текст', '@@S1\n@@S2\n@@END', '\0\0\0']) {
      expect(() => parseProbeV2(bad)).not.toThrow()
    }
  })

  it('на пустом вводе не выдумывает данные', () => {
    const out = parseProbeV2('')
    expect(out.diskIoAvailable).toBe(false)
    expect(Number.isFinite(out.cpu)).toBe(true)
  })
})
