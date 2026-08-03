import { describe, expect, it } from 'vitest'
import { costOf, deepseekPeakMultiplier, missingRates, perMillion, ratesFor, type Rates, type TokenUsage } from './ai-pricing'

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  ...over
})

// Ставки Anthropic Opus порядка реальных: вход $3/1M, выход $15/1M, запись кэша $3.75/1M,
// часовая запись $6/1M, чтение $0.30/1M.
const opus: Rates = {
  input: 0.000003,
  output: 0.000015,
  cacheWrite: 0.00000375,
  cacheWrite1h: 0.000006,
  cacheRead: 0.0000003
}

describe('стоимость расхода', () => {
  it('считает каждую ставку отдельно', () => {
    const cost = costOf(usage({ input: 1_000_000, output: 1_000_000 }), opus)
    expect(cost).toBeCloseTo(18, 6)
  })

  it('чтение кэша НЕ считается по цене входа — иначе счёт завышается в десять раз', () => {
    const cached = costOf(usage({ cacheRead: 1_000_000 }), opus)
    const plain = costOf(usage({ input: 1_000_000 }), opus)
    expect(cached).toBeCloseTo(0.3, 6)
    expect(plain / cached).toBeCloseTo(10, 3)
  })

  it('часовой кэш дороже пятиминутного', () => {
    const short = costOf(usage({ cacheWrite: 1_000_000 }), opus)
    const long = costOf(usage({ cacheWrite1h: 1_000_000 }), opus)
    expect(long).toBeGreaterThan(short)
  })

  it('нет часовой ставки — берём пятиминутную, а не ноль', () => {
    const rates: Rates = { ...opus, cacheWrite1h: null }
    expect(costOf(usage({ cacheWrite1h: 1_000_000 }), rates)).toBeCloseTo(3.75, 6)
  })

  it('нет ставок вовсе — ноль, но об этом сообщается отдельно', () => {
    const empty: Rates = { input: null, output: null, cacheWrite: null, cacheWrite1h: null, cacheRead: null }
    expect(costOf(usage({ input: 100, output: 50 }), empty)).toBe(0)
    expect(missingRates(usage({ input: 100, output: 50 }), empty)).toEqual(['вход', 'выход'])
    // Молчание о неизвестной ставке опаснее нуля: «$0 за день» читается как «бесплатно».
    expect(missingRates(usage({ input: 100 }), opus)).toEqual([])
  })
})

describe('ставки доступа', () => {
  it('наценка роутера применяется ко всем ставкам', () => {
    const r = ratesFor(opus, { markupPct: 10 })
    expect(r.input).toBeCloseTo(0.0000033, 12)
    expect(r.cacheRead).toBeCloseTo(0.00000033, 12)
  })

  it('ручная цена побеждает и каталог, и наценку', () => {
    const r = ratesFor(opus, { markupPct: 50, priceInput: 0.000001 })
    expect(r.input).toBe(0.000001)
    // Остальные ставки наценку всё же получают: заменили одну цену, а не весь прайс.
    expect(r.output).toBeCloseTo(0.0000225, 12)
  })

  it('без переопределений ставки не меняются', () => {
    expect(ratesFor(opus)).toEqual(opus)
  })
})

describe('цена за миллион', () => {
  it('переводит ставку за токен в привычный формат прайс-листов', () => {
    expect(perMillion(0.000003)).toBeCloseTo(3, 9)
    expect(perMillion(null)).toBeNull()
  })
})

describe('часы пик DeepSeek', () => {
  // Тариф удваивается в 04:00–07:00 и 09:00–13:00 по Москве. Проверяем по UTC, потому что
  // приложение может работать в любом поясе, а тариф считается по московскому времени.
  it('удваивает цену в утреннее и дневное окно', () => {
    expect(deepseekPeakMultiplier(new Date('2026-08-03T02:30:00Z'))).toBe(2) // 05:30 МСК
    expect(deepseekPeakMultiplier(new Date('2026-08-03T07:00:00Z'))).toBe(2) // 10:00 МСК
  })

  it('вечером и ночью тариф базовый', () => {
    expect(deepseekPeakMultiplier(new Date('2026-08-03T17:00:00Z'))).toBe(1) // 20:00 МСК
    expect(deepseekPeakMultiplier(new Date('2026-08-03T22:00:00Z'))).toBe(1) // 01:00 МСК
  })

  it('границы окна не включают его конец', () => {
    expect(deepseekPeakMultiplier(new Date('2026-08-03T04:00:00Z'))).toBe(1) // 07:00 МСК
    expect(deepseekPeakMultiplier(new Date('2026-08-03T10:00:00Z'))).toBe(1) // 13:00 МСК
  })
})
