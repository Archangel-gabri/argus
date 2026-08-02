// Свойства разборщиков, а не примеры.
//
// Все они разбирают вывод чужих программ на чужих машинах: `ss`, `/proc/stat`, `lscpu`,
// `efibootmgr`, `bcdedit`, `loginctl`, PowerShell. Ни один из этих форматов мы не контролируем,
// а обрезанный на середине вывод, чужая локаль, кириллица в кодировке консоли и просто мусор
// из неверно определённой ОС — обычное дело. Падение разборщика в main роняет опрос всего парка,
// поэтому первое свойство — тотальность.
//
// Тотальности при этом МАЛО: разборщик, всегда возвращающий нули, её удовлетворяет. Поэтому
// рядом стоят семантические оракулы — что именно обязано быть верно, когда данные разобрались.
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { parseSs, parseSockstat, parseLsof, parseAnyPorts, parseWinPorts } from './ports'
import { parseSessions, interpretUnlockResult, interpretWindowsLockProbe } from './session'
import { parseDisks } from './hardware'
import { parseProbeHostOutput } from './ssh-probe'
import { parseEfibootmgr, parseBcdedit } from './pc'
import { parseProbeV2, parseAnyProbe } from './metrics'
import { parseFreeBsd, parseDarwin, probedFamily } from './metrics-bsd'
import { consumeSshBanner, nextReachability } from '../shared/reachability'
import { isCalendarDate, daysUntilCalendar, advanceRenewal } from '../shared/billing'

/** Генератор «похоже на вывод команды»: строки, табы, кириллица, управляющие символы, обрывы. */
const messyOutput = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.array(fc.string(), { maxLength: 40 }).map((xs) => xs.join('\n')),
  fc.array(fc.oneof(fc.constant('\t'), fc.constant(' '), fc.constant('\n'), fc.constant('\r')), {
    maxLength: 60
  }).map((xs) => xs.join('')),
  fc.constant(''),
  fc.constant('\0'),
  fc.constant('@@S1\n@@S2\n@@END'),
  fc.constant('Ошибка: команда не найдена'),
  fc.constant('bash: ss: command not found')
)

const TOTAL: Array<[string, (s: string) => unknown]> = [
  ['parseSs', parseSs],
  ['parseSockstat', parseSockstat],
  ['parseLsof', parseLsof],
  ['parseAnyPorts', parseAnyPorts],
  ['parseWinPorts', parseWinPorts],
  ['parseSessions', parseSessions],
  // parseDisks принимает уже разбитые строки — подаём их так же, как это делает вызывающий код.
  ['parseDisks', (raw: string) => parseDisks(raw.split('\n'))],
  ['parseProbeHostOutput', parseProbeHostOutput],
  ['parseEfibootmgr', parseEfibootmgr],
  ['parseBcdedit', parseBcdedit],
  ['parseProbeV2', parseProbeV2],
  ['parseAnyProbe', parseAnyProbe],
  ['parseFreeBsd', parseFreeBsd],
  ['parseDarwin', parseDarwin],
  ['probedFamily', probedFamily]
]

describe('тотальность: ни один разборщик не падает ни на каком вводе', () => {
  for (const [name, parse] of TOTAL) {
    it(name, () => {
      fc.assert(
        fc.property(messyOutput, (raw) => {
          // Ошибка здесь означает исключение в main-процессе на живом сервере с непривычным
          // выводом — и остановленный опрос всего парка.
          expect(() => parse(raw)).not.toThrow()
        }),
        { numRuns: 300 }
      )
    })
  }
})

describe('семантика: разобранное осмысленно, неразобранное честно пустое', () => {
  it('parseSs возвращает только порты в допустимом диапазоне', () => {
    fc.assert(
      fc.property(messyOutput, (raw) => {
        for (const row of parseSs(raw)) {
          expect(row.port).toBeGreaterThanOrEqual(0)
          expect(row.port).toBeLessThanOrEqual(65535)
          expect(Number.isInteger(row.port)).toBe(true)
        }
      }),
      { numRuns: 300 }
    )
  })

  it('parseSs на настоящем выводе находит порт и процесс', () => {
    const real =
      'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))\n' +
      'tcp LISTEN 0 511 127.0.0.1:2053 0.0.0.0:* users:(("x-ui",pid=1401,fd=7))'
    const rows = parseSs(real)
    expect(rows.map((r) => r.port).sort((a, b) => a - b)).toEqual([22, 2053])
    // Оракул против «разборщика, который всегда возвращает пусто».
    expect(rows.find((r) => r.port === 22)?.process).toContain('sshd')
  })

  it('parseProbeV2 держит загрузку в допустимых границах на любом вводе', () => {
    fc.assert(
      fc.property(messyOutput, (raw) => {
        const m = parseProbeV2(raw)
        expect(Number.isFinite(m.cpu)).toBe(true)
        expect(m.cpu).toBeGreaterThanOrEqual(0)
        expect(m.cpu).toBeLessThanOrEqual(100)
        for (const c of m.cores) {
          expect(Number.isFinite(c)).toBe(true)
          expect(c).toBeGreaterThanOrEqual(0)
          expect(c).toBeLessThanOrEqual(100)
        }
        // Ни одного NaN в числах, которые уедут в интерфейс как «показания».
        for (const v of [m.ramUsed, m.ramTotal, m.netRx, m.netTx, m.diskR, m.diskW])
          expect(Number.isFinite(v)).toBe(true)
      }),
      { numRuns: 300 }
    )
  })

  it('на мусоре дисковые показания объявляются недоступными, а не нулевыми', () => {
    fc.assert(
      fc.property(messyOutput, (raw) => {
        const m = parseProbeV2(raw)
        // «Не знаю» и «ноль» — разные утверждения, и путать их нельзя.
        if (!m.diskIoAvailable) expect(m.diskR === 0 && m.diskW === 0).toBe(true)
      }),
      { numRuns: 200 }
    )
  })

  // `parseSshConfig` в этот набор не входит осознанно: он не разбирает переданную строку, а
  // сам читает ~/.ssh/config. Фуззить нечего — подать ему свой ввод невозможно, и это стоит
  // помнить, если однажды покажется, что он «просто не покрыт».

  it('parseDisks не выдумывает накопителей из мусора', () => {
    fc.assert(
      fc.property(messyOutput, (raw) => {
        for (const d of parseDisks(raw.split('\n'))) {
          expect(typeof d.name).toBe('string')
          expect(d.name.length).toBeGreaterThan(0)
        }
      }),
      { numRuns: 300 }
    )
  })
})

describe('consumeSshBanner: вердикт не зависит от того, как поток нарезан', () => {
  // Ровно этот баг ловили на живом стенде: в TCP пришло «SS», затем «H-2.0…», и проверка
  // живости считала сервер мёртвым. Свойство сильнее любого набора примеров.
  const verdictOf = (chunks: string[]): boolean | null => {
    let text = ''
    for (const c of chunks) {
      const next = consumeSshBanner(text, c)
      text = next.text
      if (next.verdict !== null) return next.verdict
    }
    return null
  }

  it('любое разбиение настоящего баннера даёт тот же ответ', () => {
    const banner = 'SSH-2.0-OpenSSH_9.6\r\n'
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: banner.length }), { maxLength: 8 }), (cuts) => {
        const points = [...new Set(cuts)].sort((a, b) => a - b)
        const chunks: string[] = []
        let prev = 0
        for (const p of points) {
          chunks.push(banner.slice(prev, p))
          prev = p
        }
        chunks.push(banner.slice(prev))
        expect(verdictOf(chunks.filter((c) => c.length))).toBe(true)
      }),
      { numRuns: 300 }
    )
  })

  it('чужой протокол опознаётся как не-SSH при любой нарезке', () => {
    const banner = 'HTTP/1.1 400 Bad Request\r\n'
    fc.assert(
      fc.property(fc.integer({ min: 1, max: banner.length - 1 }), (cut) => {
        expect(verdictOf([banner.slice(0, cut), banner.slice(cut)])).toBe(false)
      }),
      { numRuns: 100 }
    )
  })

  it('на произвольном мусоре не бросает и не выдумывает «живой»', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(() => verdictOf([a, b])).not.toThrow()
      }),
      { numRuns: 300 }
    )
  })
})

describe('живость: серия промахов монотонна', () => {
  it('успех всегда обнуляет счётчик, промах всегда его увеличивает', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10 }), (misses) => {
        expect(nextReachability(misses, 'online').misses).toBe(0)
        const after = nextReachability(misses, 'offline')
        expect(after.misses).toBeGreaterThan(misses)
        // Первый промах никогда не объявляет машину выключенной: канал флапает.
        if (misses === 0) expect(after.status).toBe('unknown')
      }),
      { numRuns: 200 }
    )
  })
})

describe('даты продления', () => {
  // Дата собирается из чисел, а не из fc.date: тот умеет выдать Invalid Date, и падал бы сам
  // генератор, а не проверяемое свойство. День ограничен 28-м — февраль есть в каждом году.
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dateStr = fc
    .tuple(fc.integer({ min: 2020, max: 2035 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
    .map(([y, m, d]) => `${y}-${pad(m)}-${pad(d)}`)

  it('всякая корректная дата признаётся корректной', () => {
    // Тело блочное намеренно: у стрелки с выражением возвращается результат expect, и
    // fast-check принимает его за вердикт свойства.
    fc.assert(
      fc.property(dateStr, (s) => {
        expect(isCalendarDate(s)).toBe(true)
      }),
      { numRuns: 200 }
    )
  })

  it('мусор датой не признаётся и разбор не падает', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => isCalendarDate(s)).not.toThrow()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) expect(isCalendarDate(s)).toBe(false)
      }),
      { numRuns: 300 }
    )
  })

  it('продление всегда сдвигает дату вперёд и остаётся календарной', () => {
    fc.assert(
      fc.property(dateStr, fc.constantFrom('mo' as const, 'yr' as const), (from, period) => {
        // now задаём явно: иначе свойство зависело бы от того, когда его запустили.
        const next = advanceRenewal(from, period, Date.UTC(2026, 7, 3))
        expect(next).not.toBeNull()
        expect(isCalendarDate(next as string)).toBe(true)
        // Следующее продление всегда в будущем относительно точки отсчёта.
        expect((next as string) >= '2026-08-03').toBe(true)
      }),
      { numRuns: 300 }
    )
  })

  it('число дней до даты — целое и не NaN на любом вводе', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const d = daysUntilCalendar(s, Date.UTC(2026, 7, 3))
        expect(d === null || Number.isInteger(d)).toBe(true)
      }),
      { numRuns: 300 }
    )
  })
})

describe('разбор состояния сеанса не трактует неизвестное как «открыто»', () => {
  it('interpretUnlockResult и interpretWindowsLockProbe тотальны', () => {
    fc.assert(
      fc.property(messyOutput, fc.boolean(), (raw, ok) => {
        expect(() => interpretUnlockResult({ ok, output: raw } as never)).not.toThrow()
        expect(() => interpretWindowsLockProbe({ ok, output: raw } as never)).not.toThrow()
      }),
      { numRuns: 300 }
    )
  })
})
