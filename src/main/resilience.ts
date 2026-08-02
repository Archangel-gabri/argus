/**
 * Устойчивость к отказам чужих служб: повтор с растущей паузой и размыкатель цепи.
 *
 * Все внешние обращения Argus — ЧТЕНИЕ у публичных бесплатных служб: курсы, балансы, гео,
 * проверка ИИ-ключей. У таких служб три обычных состояния: мгновенный отказ по лимиту (429),
 * недолгая пятисотка и полная недоступность. Раньше каждое из них давало одно и то же —
 * единичную неудачу, после которой значение просто не появлялось.
 *
 * Две вещи, которые здесь принципиальны и определяют весь дизайн.
 *
 * ПЕРВОЕ: повторять можно ТОЛЬКО идемпотентное. Здесь это выполняется по построению — ни один
 * внешний вызов Argus ничего не меняет на той стороне. Если однажды появится вызов, который
 * что-то создаёт или списывает, его нельзя заворачивать в `retry` не подумав: повтор оплаты
 * хуже, чем неудачная оплата.
 *
 * ВТОРОЕ: разомкнутая цепь возвращает «не знаю», а НЕ ноль. Это продолжение правила, которое в
 * проекте уже оплачено кровью: показать ноль вместо неизвестности — значит соврать про деньги
 * или про состояние машины. Поэтому размыкатель бросает, а не подставляет пустое значение.
 */

export interface RetryOptions {
  /** Сколько ВСЕГО попыток, включая первую. */
  attempts?: number
  /** Базовая пауза; дальше удваивается. */
  baseDelayMs?: number
  /** Потолок паузы: без него шестая попытка ждала бы минуту. */
  maxDelayMs?: number
  /** Доля случайного разброса паузы, 0..1. */
  jitter?: number
  /**
   * Общий бюджет времени на ВСЕ попытки, мс.
   *
   * Без него повторы просто умножают ожидание: три попытки по десять секунд превращают
   * зависшую службу в тридцать секунд простоя, и опрос парка встаёт. Счётчик попыток
   * ограничивает количество, а бюджет — то, что чувствует человек.
   */
  budgetMs?: number
  /** Часы (подменяются в тестах). */
  now?: () => number
  /** Подождать столько миллисекунд (подменяется в тестах). */
  sleep?: (ms: number) => Promise<void>
  /** Источник случайности (подменяется в тестах). */
  random?: () => number
  /** Сообщить о повторе — для журнала и диагностики. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

export const DEFAULT_RETRY: Required<
  Omit<RetryOptions, 'sleep' | 'random' | 'onRetry' | 'budgetMs' | 'now'>
> = {
  attempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 8_000,
  jitter: 0.3
}

/** Ошибка, которую сама служба попросила повторить позже (429/503 с Retry-After). */
export class RetryableHttpError extends Error {
  constructor(
    readonly status: number,
    /** Сколько служба просит подождать, мс. undefined — решаем сами. */
    readonly retryAfterMs?: number
  ) {
    super(`HTTP ${status}`)
    this.name = 'RetryableHttpError'
  }
}

/** Ошибка, повторять которую бессмысленно: чужой запрос не станет верным сам по себе. */
export class PermanentHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'PermanentHttpError'
  }
}

/**
 * Стоит ли повторять.
 *
 * 4xx повторять НЕЛЬЗЯ: неверный ключ, неверный адрес и неизвестный кошелёк не исправятся от
 * того, что мы спросим ещё раз, — а лимит запросов от лишних попыток только продлится.
 * Исключения ровно два: 429 (служба сама сказала «позже») и 408.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof RetryableHttpError) return true
  if (error instanceof PermanentHttpError) return false
  if (error instanceof Error) {
    // Сетевые отказы и таймауты — самый частый повод повторить.
    if (/abort|timeout|тайм-аут|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network/i.test(
        `${error.name} ${error.message}`
      ))
      return true
  }
  return false
}

/** Классифицировать HTTP-ответ. Возвращает null, если ответ пригоден к разбору. */
export function classifyResponse(status: number, retryAfterHeader?: string | null): Error | null {
  if (status >= 200 && status < 300) return null
  if (status === 429 || status === 408 || status >= 500) {
    return new RetryableHttpError(status, parseRetryAfter(retryAfterHeader))
  }
  return new PermanentHttpError(status)
}

/** `Retry-After` бывает и числом секунд, и датой — уважаем оба, но не даём себя усыпить надолго. */
export function parseRetryAfter(header: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return clampWait(Number(trimmed) * 1000)
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return clampWait(at - nowMs)
}

/** Потолок ожидания: чужая служба не должна подвешивать наш опрос на минуты. */
const MAX_RETRY_AFTER_MS = 30_000
const clampWait = (ms: number): number => Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS))

/** Пауза перед попыткой n (нумерация с 1) — удвоение с потолком и разбросом. */
export function backoffDelay(attempt: number, o: RetryOptions = {}, random: () => number = Math.random): number {
  const base = o.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs
  const max = o.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs
  const jitter = o.jitter ?? DEFAULT_RETRY.jitter
  const raw = Math.min(base * 2 ** (attempt - 1), max)
  // Разброс нужен не для красоты: без него несколько кошельков, упавших разом, пойдут на
  // повтор в одну и ту же миллисекунду и снова получат лимит.
  const spread = raw * jitter
  return Math.round(raw - spread / 2 + random() * spread)
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Выполнить с повторами. Бросает ПОСЛЕДНЮЮ ошибку, если все попытки исчерпаны. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY.attempts
  const sleep = options.sleep ?? realSleep
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const startedAt = now()
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isRetryable(error)) throw error

      // Просьбу службы уважаем: она знает про свой лимит больше, чем наша формула.
      const asked = error instanceof RetryableHttpError ? error.retryAfterMs : undefined
      const delayMs = asked ?? backoffDelay(attempt, options, random)

      // Бюджет считаем ВПЕРЁД: нет смысла ждать паузу, если следующая попытка всё равно не
      // успеет уложиться. Иначе человек ждёт дольше ровно затем, чтобы получить тот же отказ.
      if (options.budgetMs !== undefined && now() - startedAt + delayMs >= options.budgetMs) throw error

      options.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
  throw lastError
}

// ── Размыкатель цепи ────────────────────────────────────────────────────────────────────────

export type BreakerState = 'closed' | 'open' | 'half-open'

/** Отказ, вызванный тем, что цепь разомкнута: запрос даже не отправлялся. */
export class CircuitOpenError extends Error {
  constructor(readonly service: string, readonly retryAtMs: number) {
    super(`${service}: служба недоступна, следующая попытка позже`)
    this.name = 'CircuitOpenError'
  }
}

export interface BreakerOptions {
  /** Сколько подряд неудач размыкают цепь. */
  threshold?: number
  /** Сколько держать разомкнутой, прежде чем пробовать снова. */
  cooldownMs?: number
  now?: () => number
}

/**
 * Размыкатель на службу.
 *
 * Смысл не в экономии запросов, а в скорости честного ответа. Когда CoinGecko лежит, каждый
 * кошелёк платит десять секунд таймаута плюс повторы; на пяти кошельках это минута, в течение
 * которой интерфейс делает вид, что считает. Разомкнутая цепь отвечает мгновенно и честно:
 * «сейчас неизвестно», а не «ноль» и не «сейчас-сейчас».
 */
export class CircuitBreaker {
  private failures = 0
  private openedAt = 0
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(
    readonly service: string,
    options: BreakerOptions = {}
  ) {
    this.threshold = options.threshold ?? 4
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  get state(): BreakerState {
    if (this.failures < this.threshold) return 'closed'
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open'
  }

  /** Диагностика: сколько неудач подряд насчитано. */
  get consecutiveFailures(): number {
    return this.failures
  }

  /** Сбросить вручную — например, когда владелец сам нажал «повторить». */
  reset(): void {
    this.failures = 0
    this.openedAt = 0
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      throw new CircuitOpenError(this.service, this.openedAt + this.cooldownMs)
    }
    try {
      const result = await fn()
      // Успех в полуразомкнутом состоянии закрывает цепь целиком: служба вернулась.
      this.failures = 0
      return result
    } catch (error) {
      // Постоянные ошибки (401, 404) — это про НАШ запрос, а не про здоровье службы.
      // Считать их отказами службы значит размыкать цепь из-за одного неверного адреса
      // и лишать данных все остальные кошельки.
      if (!(error instanceof PermanentHttpError)) {
        this.failures++
        if (this.failures === this.threshold) this.openedAt = this.now()
        else if (this.failures > this.threshold) this.openedAt = this.now()
      }
      throw error
    }
  }
}

const breakers = new Map<string, CircuitBreaker>()

/** Один размыкатель на службу, общий для всех вызывающих. */
export function breakerFor(service: string, options?: BreakerOptions): CircuitBreaker {
  let b = breakers.get(service)
  if (!b) {
    b = new CircuitBreaker(service, options)
    breakers.set(service, b)
  }
  return b
}

/** Забыть все размыкатели. Зовётся при блокировке: новая сессия начинает с чистого листа. */
export function resetAllBreakers(): void {
  for (const b of breakers.values()) b.reset()
}

/** Состояние всех служб — для диагностики и интерфейса. */
export function breakerStates(): Array<{ service: string; state: BreakerState; failures: number }> {
  return [...breakers.values()].map((b) => ({
    service: b.service,
    state: b.state,
    failures: b.consecutiveFailures
  }))
}

/** Обычная связка: размыкатель снаружи, повторы внутри. */
export async function resilient<T>(
  service: string,
  fn: () => Promise<T>,
  options: RetryOptions & BreakerOptions = {}
): Promise<T> {
  return breakerFor(service, options).run(() => retry(fn, options))
}
