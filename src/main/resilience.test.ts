import { describe, it, expect, vi } from 'vitest'
import {
  retry,
  isRetryable,
  classifyResponse,
  parseRetryAfter,
  backoffDelay,
  CircuitBreaker,
  CircuitOpenError,
  RetryableHttpError,
  PermanentHttpError,
  resilient,
  breakerFor,
  resetAllBreakers
} from './resilience'

// Время в тестах не идёт по-настоящему: паузы подменяются, часы подменяются. Иначе проверка
// экспоненциальной задержки сама стала бы самой медленной в наборе.
const noSleep = (): Promise<void> => Promise.resolve()
const fixedRandom = (): number => 0.5

describe('isRetryable — что вообще имеет смысл повторять', () => {
  it('сетевые отказы и таймауты повторяем', () => {
    for (const msg of [
      'ECONNRESET',
      'socket hang up',
      'ETIMEDOUT',
      'getaddrinfo EAI_AGAIN api.example',
      'The operation was aborted',
      'тайм-аут RPC — баланс неизвестен'
    ]) {
      expect(isRetryable(new Error(msg)), msg).toBe(true)
    }
  })

  it('постоянные ошибки НЕ повторяем', () => {
    // Неверный ключ и несуществующий адрес не исправятся от повтора, а лимит только продлится.
    expect(isRetryable(new PermanentHttpError(401))).toBe(false)
    expect(isRetryable(new PermanentHttpError(404))).toBe(false)
    expect(isRetryable(new Error('Ответ RPC не содержит баланс'))).toBe(false)
  })

  it('явно помеченное как временное — повторяем', () => {
    expect(isRetryable(new RetryableHttpError(503))).toBe(true)
  })
})

describe('classifyResponse', () => {
  it('успех не является ошибкой', () => {
    expect(classifyResponse(200)).toBeNull()
    expect(classifyResponse(204)).toBeNull()
  })

  it('429, 408 и пятисотки — временные', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(classifyResponse(s)).toBeInstanceOf(RetryableHttpError)
    }
  })

  it('остальные 4xx — постоянные', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(classifyResponse(s)).toBeInstanceOf(PermanentHttpError)
    }
  })

  it('просьбу подождать из заголовка передаёт дальше', () => {
    const e = classifyResponse(429, '5') as RetryableHttpError
    expect(e.retryAfterMs).toBe(5000)
  })
})

describe('parseRetryAfter', () => {
  it('понимает секунды', () => {
    expect(parseRetryAfter('7')).toBe(7000)
  })

  it('понимает дату', () => {
    const now = Date.parse('2026-08-03T00:00:00Z')
    expect(parseRetryAfter('Mon, 03 Aug 2026 00:00:10 GMT', now)).toBe(10_000)
  })

  it('прошедшая дата означает «можно сразу», а не отрицательную паузу', () => {
    const now = Date.parse('2026-08-03T00:00:30Z')
    expect(parseRetryAfter('Mon, 03 Aug 2026 00:00:00 GMT', now)).toBe(0)
  })

  it('не даёт чужой службе усыпить нас надолго', () => {
    // Без потолка «Retry-After: 3600» подвесил бы опрос парка на час.
    expect(parseRetryAfter('3600')).toBe(30_000)
  })

  it('мусор и отсутствие заголовка — решаем сами', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('скоро')).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
  })
})

describe('backoffDelay', () => {
  it('удваивается от попытки к попытке', () => {
    const o = { baseDelayMs: 100, jitter: 0 }
    expect(backoffDelay(1, o, fixedRandom)).toBe(100)
    expect(backoffDelay(2, o, fixedRandom)).toBe(200)
    expect(backoffDelay(3, o, fixedRandom)).toBe(400)
  })

  it('упирается в потолок, а не растёт до бесконечности', () => {
    const o = { baseDelayMs: 100, maxDelayMs: 500, jitter: 0 }
    expect(backoffDelay(10, o, fixedRandom)).toBe(500)
  })

  it('разброс держится вокруг базовой величины', () => {
    const o = { baseDelayMs: 1000, jitter: 0.5 }
    const low = backoffDelay(1, o, () => 0)
    const high = backoffDelay(1, o, () => 1)
    // Разброс нужен, чтобы упавшие разом запросы не пошли на повтор в одну миллисекунду.
    expect(low).toBeLessThan(1000)
    expect(high).toBeGreaterThan(1000)
    expect(high - low).toBeCloseTo(500, -1)
  })
})

describe('retry', () => {
  it('успех с первой попытки не создаёт пауз', async () => {
    const sleep = vi.fn(noSleep)
    const fn = vi.fn().mockResolvedValue('готово')
    expect(await retry(fn, { sleep })).toBe('готово')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('повторяет временную ошибку и возвращает результат', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue('со-третьей')
    expect(await retry(fn, { sleep: noSleep, random: fixedRandom })).toBe('со-третьей')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('постоянную ошибку НЕ повторяет ни разу', async () => {
    const fn = vi.fn().mockRejectedValue(new PermanentHttpError(401))
    await expect(retry(fn, { sleep: noSleep })).rejects.toBeInstanceOf(PermanentHttpError)
    // Именно один вызов: повторять неверный ключ бессмысленно и вредно.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('исчерпав попытки, бросает ПОСЛЕДНЮЮ ошибку, а не первую', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET первая'))
      .mockRejectedValue(new Error('ETIMEDOUT последняя'))
    await expect(retry(fn, { attempts: 3, sleep: noSleep, random: fixedRandom })).rejects.toThrow(/последняя/)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('паузы растут между попытками', async () => {
    const waited: number[] = []
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(
      retry(fn, {
        attempts: 4,
        baseDelayMs: 100,
        jitter: 0,
        random: fixedRandom,
        sleep: async (ms) => {
          waited.push(ms)
        }
      })
    ).rejects.toThrow()
    expect(waited).toEqual([100, 200, 400])
  })

  it('уважает просьбу службы подождать вместо своей формулы', async () => {
    const waited: number[] = []
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableHttpError(429, 2500))
      .mockResolvedValue('ок')
    await retry(fn, {
      baseDelayMs: 100,
      jitter: 0,
      sleep: async (ms) => {
        waited.push(ms)
      }
    })
    // Служба знает про свой лимит больше, чем наша формула.
    expect(waited).toEqual([2500])
  })

  it('сообщает о каждом повторе — иначе отказы остаются невидимыми', async () => {
    const onRetry = vi.fn()
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('ок')
    await retry(fn, { sleep: noSleep, random: fixedRandom, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][0].attempt).toBe(1)
  })
})

describe('CircuitBreaker', () => {
  const clock = (): { now: () => number; advance: (ms: number) => void } => {
    let t = 1_000_000
    return { now: () => t, advance: (ms) => (t += ms) }
  }

  it('пока служба отвечает, цепь замкнута', async () => {
    const b = new CircuitBreaker('тест')
    expect(await b.run(async () => 'ок')).toBe('ок')
    expect(b.state).toBe('closed')
  })

  it('размыкается после порога неудач подряд', async () => {
    const b = new CircuitBreaker('тест', { threshold: 3 })
    for (let i = 0; i < 3; i++) {
      await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()
    }
    expect(b.state).toBe('open')
  })

  it('разомкнутая цепь отвечает МГНОВЕННО и не отправляет запрос', async () => {
    const b = new CircuitBreaker('тест', { threshold: 1 })
    await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()

    const fn = vi.fn()
    await expect(b.run(fn)).rejects.toBeInstanceOf(CircuitOpenError)
    // Смысл размыкателя: не ждать десять секунд таймаута на каждом кошельке, когда служба лежит.
    expect(fn).not.toHaveBeenCalled()
  })

  it('через остывание пропускает пробный запрос', async () => {
    const c = clock()
    const b = new CircuitBreaker('тест', { threshold: 1, cooldownMs: 30_000, now: c.now })
    await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()
    expect(b.state).toBe('open')

    c.advance(30_000)
    expect(b.state).toBe('half-open')
    const fn = vi.fn().mockResolvedValue('вернулась')
    expect(await b.run(fn)).toBe('вернулась')
    // Успех пробного запроса закрывает цепь целиком.
    expect(b.state).toBe('closed')
  })

  it('неудача пробного запроса снова размыкает и отсчитывает остывание заново', async () => {
    const c = clock()
    const b = new CircuitBreaker('тест', { threshold: 1, cooldownMs: 10_000, now: c.now })
    await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()
    c.advance(10_000)
    await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()
    expect(b.state).toBe('open')
    c.advance(9_000)
    expect(b.state).toBe('open')
    c.advance(1_000)
    expect(b.state).toBe('half-open')
  })

  it('НАША ошибка не считается отказом службы', async () => {
    // 401 или 404 — это про наш запрос: неверный ключ, несуществующий адрес. Размыкать из-за
    // одного неверного кошелька и лишать данных остальные — неверно.
    const b = new CircuitBreaker('тест', { threshold: 2 })
    for (let i = 0; i < 5; i++) {
      await expect(b.run(() => Promise.reject(new PermanentHttpError(404)))).rejects.toThrow()
    }
    expect(b.state).toBe('closed')
    expect(b.consecutiveFailures).toBe(0)
  })

  it('успех обнуляет счётчик неудач', async () => {
    const b = new CircuitBreaker('тест', { threshold: 3 })
    await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()
    await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()
    await b.run(async () => 'ок')
    expect(b.consecutiveFailures).toBe(0)
    // И следующая неудача снова считается первой, а не третьей.
    await expect(b.run(() => Promise.reject(new Error('ECONNRESET')))).rejects.toThrow()
    expect(b.state).toBe('closed')
  })
})

describe('resilient — размыкатель снаружи, повторы внутри', () => {
  it('повторяет, пока цепь замкнута', async () => {
    resetAllBreakers()
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('ок')
    expect(await resilient('служба-А', fn, { sleep: noSleep, random: fixedRandom })).toBe('ок')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('разомкнув цепь, перестаёт тратить время на повторы', async () => {
    resetAllBreakers()
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const opts = { attempts: 2, threshold: 1, sleep: noSleep, random: fixedRandom }
    await expect(resilient('служба-Б', fn, opts)).rejects.toThrow()
    const calls = fn.mock.calls.length

    await expect(resilient('служба-Б', fn, opts)).rejects.toBeInstanceOf(CircuitOpenError)
    // Ни одного нового обращения: вот ради чего размыкатель и нужен.
    expect(fn.mock.calls.length).toBe(calls)
    breakerFor('служба-Б').reset()
  })

  it('размыкатель у каждой службы свой', async () => {
    resetAllBreakers()
    const bad = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const good = vi.fn().mockResolvedValue('ок')
    const opts = { attempts: 1, threshold: 1, sleep: noSleep }
    await expect(resilient('упавшая', bad, opts)).rejects.toThrow()
    // Падение курсов не должно лишать нас балансов.
    expect(await resilient('живая', good, opts)).toBe('ок')
    resetAllBreakers()
  })
})
