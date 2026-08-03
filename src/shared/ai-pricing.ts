// Счёт денег за токены. Чистые функции без базы, сети и Electron — их зовут и main (когда
// разбирает логи), и renderer (когда рисует калькулятор), и проверки.
//
// Главная мысль: «цена за токен» — это четыре разные цены. У агентных сессий основную долю
// трафика составляет ЧТЕНИЕ кэша (оно в 10 раз дешевле входа), а запись кэша, наоборот, дороже
// обычного входа. Считать всё по одной ставке — ошибиться в разы, причём в обе стороны.

/** Сколько токенов израсходовано за один ответ или за день. */
export interface TokenUsage {
  input: number
  output: number
  /** Запись кэша со сроком жизни 5 минут. */
  cacheWrite: number
  /** Запись кэша со сроком жизни 1 час — дороже пятиминутной. */
  cacheWrite1h: number
  /** Чтение из кэша — самая дешёвая ставка. */
  cacheRead: number
}

/** Ставки в долларах за ОДИН токен (формат каталога LiteLLM). */
export interface Rates {
  input: number | null
  output: number | null
  cacheWrite: number | null
  cacheWrite1h: number | null
  cacheRead: number | null
}

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheRead: a.cacheRead + b.cacheRead
  }
}

export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheWrite + u.cacheWrite1h + u.cacheRead
}

/**
 * Стоимость расхода по ставкам.
 *
 * Неизвестная ставка считается нулём осознанно: альтернатива — «не знаю, сколько всё это стоит»
 * для целого дня из-за одной модели без цены. Что цена неполная, видно по `missing`.
 */
export function costOf(usage: TokenUsage, rates: Rates): number {
  const cacheWrite1hRate =
    // Часовой ставки в каталоге может не быть. Тогда честнее взять пятиминутную, чем ноль:
    // запись кэша точно не бесплатна. Занижение здесь заметить нельзя, а нулём — можно.
    rates.cacheWrite1h ?? rates.cacheWrite ?? null
  return (
    usage.input * (rates.input ?? 0) +
    usage.output * (rates.output ?? 0) +
    usage.cacheWrite * (rates.cacheWrite ?? rates.input ?? 0) +
    usage.cacheWrite1h * (cacheWrite1hRate ?? rates.input ?? 0) +
    usage.cacheRead * (rates.cacheRead ?? 0)
  )
}

/** Каких ставок не хватило, чтобы посчитать честно. Пустой список — счёт полный. */
export function missingRates(usage: TokenUsage, rates: Rates): string[] {
  const out: string[] = []
  if (usage.input > 0 && rates.input == null) out.push('вход')
  if (usage.output > 0 && rates.output == null) out.push('выход')
  if (usage.cacheWrite + usage.cacheWrite1h > 0 && rates.cacheWrite == null && rates.input == null)
    out.push('запись кэша')
  if (usage.cacheRead > 0 && rates.cacheRead == null) out.push('чтение кэша')
  return out
}

/**
 * Ставки доступа: каталожная цена, поверх неё наценка роутера/реселлера, поверх всего — ручная.
 * Порядок важен: ручная цена задаётся уже «как есть», наценку к ней применять нельзя.
 */
export function ratesFor(
  base: Rates,
  override?: { markupPct?: number | null; priceInput?: number | null; priceOutput?: number | null }
): Rates {
  const k = 1 + (override?.markupPct ?? 0) / 100
  const scale = (v: number | null): number | null => (v == null ? null : v * k)
  return {
    input: override?.priceInput ?? scale(base.input),
    output: override?.priceOutput ?? scale(base.output),
    cacheWrite: scale(base.cacheWrite),
    cacheWrite1h: scale(base.cacheWrite1h),
    cacheRead: scale(base.cacheRead)
  }
}

/** Цена за миллион токенов — то, в чём её называют все прайс-листы. */
export function perMillion(rate: number | null): number | null {
  return rate == null ? null : rate * 1_000_000
}

/**
 * У DeepSeek тариф удваивается в часы пик по московскому времени (04:00–07:00 и 09:00–13:00).
 * Это не мелочь: та же задача вечером стоит вдвое дешевле, чем утром.
 *
 * Смещение Москвы (UTC+3) задано числом, а не через часовой пояс среды: приложение может
 * работать на машине в любом поясе, а тариф всё равно считается по Москве.
 */
export function deepseekPeakMultiplier(at: Date): number {
  const mskHour = (at.getUTCHours() + 3) % 24
  const peak = (mskHour >= 4 && mskHour < 7) || (mskHour >= 9 && mskHour < 13)
  return peak ? 2 : 1
}
