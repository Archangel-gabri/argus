// Балансы на биржах: деньги, которых не видно из блокчейна.
//
// В `onchain.ts` баланс читается по адресу кошелька и ключей не требует вовсе. Биржевой счёт так
// не посмотреть: монеты владельца лежат на общих адресах биржи, и единственный способ узнать своё —
// спросить у неё самой по ключу. Ключ нужен ТОЛЬКО на чтение; ни один вызов здесь ничего не
// создаёт и не списывает, поэтому повтор безопасен по построению (условие из `resilience.ts`).
//
// Правило честности то же, что у кошельков, и здесь оно дороже: ноль показывается лишь тогда,
// когда биржа успешно ответила и там ДЕЙСТВИТЕЛЬНО ноль. Сетевой сбой, отвергнутая подпись,
// истёкший ключ и лимит запросов дают `error` с текстом. Ноль вместо «не знаю» на биржевом счёте
// читается как «счёт пуст» — то есть как кража, а не как заминка сети.
//
// Обе биржи ставят одну и ту же подножку, каждая дважды:
//   1. Числа приходят СТРОКАМИ, а незаполненное поле — это `""`. В JavaScript `Number('') === 0`,
//      поэтому наивный разбор превращает «биржа не сказала» в «на счету пусто».
//   2. Отказ приезжает с HTTP 200, а причина лежит в теле (`retCode` у Bybit, `code` у OKX).
//      Проверка `response.ok` его не видит вовсе — и неверный ключ выглядит как пустой счёт.
//
// Схемы сверены с документацией 04.08.2026 (по памяти тут полагаться нельзя — подпись ломается
// молча, а выглядит это как «денег нет»):
//   • Bybit v5, подпись — https://bybit-exchange.github.io/docs/v5/guide
//     дословно: GET подписывает «timestamp + API key + recv_window + queryString», HMAC_SHA256
//     переводится в lowercase HEX; правило времени — `server_time - recv_window <= timestamp
//     < server_time + 1000`.
//   • Bybit v5, баланс — https://bybit-exchange.github.io/docs/v5/account/wallet-balance
//   • Bybit v5, коды   — https://bybit-exchange.github.io/docs/v5/error
//   • OKX v5, подпись и баланс — https://www.okx.com/docs-v5/en/
//     дословно: «Create a pre-hash string of timestamp + method + requestPath + body… Sign the
//     pre-hash string with the SecretKey using the HMAC SHA256. Encode the signature in the Base64
//     format»; метка времени — ISO-8601 UTC с миллисекундами (`2020-12-08T09:08:57.715Z`).

import { createHmac } from 'node:crypto'
import { DeadlineError, withDeadline } from '../shared/deadline'
import {
  CircuitOpenError,
  PermanentHttpError,
  RetryableHttpError,
  classifyResponse,
  resilient
} from './resilience'

/** Одна монета на счету. `usd` = null означает «биржа не оценила», а не «стоит ноль». */
export interface ExchangeAsset {
  symbol: string
  amount: number
  usd: number | null
}

export interface ExchangeBalance {
  /** ok — состав и деньги доказаны; partial — монеты есть, долларов нет; error — баланс неизвестен. */
  status: 'ok' | 'partial' | 'error'
  assets: ExchangeAsset[]
  totalUsd: number | null
  error?: string
  fetchedAt: number
}

export type Exchange = 'bybit' | 'okx'

/** Ключ владельца. `passphrase` есть только у OKX и обязателен там. */
export interface ExchangeCreds {
  apiKey: string
  secret: string
  passphrase?: string
}

// Таймаут ОДНОЙ попытки и потолок на весь поход вместе с повторами и паузами.
//
// Числа подобраны так, чтобы повторы НЕ УДЛИНИЛИ худший случай (тот же приём, что в `onchain.ts`).
// Зависшая биржа: попытка 15с → пауза 0.6с → 15.6 ≥ бюджета → отказ примерно на 15-й секунде.
// А быстрый отказ (лимит запросов приходит мгновенно) успевает получить все три попытки.
const TIMEOUT_MS = 15_000
const BUDGET_MS = 15_500

const BYBIT_HOST = 'https://api.bybit.com'
const OKX_HOST = 'https://www.okx.com'

/**
 * Счёт, который спрашиваем.
 *
 * Честная граница: `accountType=UNIFIED` — это единый торговый счёт, а деньги на счёте
 * пополнения (Funding) он не показывает; у OKX то же самое, `/account/balance` документирован как
 * «assets… in the trading account», фондирующий счёт живёт за отдельным адресом. То есть модуль
 * отвечает на вопрос «сколько на торговом счету», а не «сколько всего на бирже».
 */
const BYBIT_PATH = '/v5/account/wallet-balance'
const BYBIT_QUERY = 'accountType=UNIFIED'
const OKX_PATH = '/api/v5/account/balance'

/**
 * Окно, в котором биржа согласна принять нашу метку времени.
 *
 * Значение обязано совпадать в заголовке и в подписи ДОСЛОВНО — это строка, а не число, и
 * `5000` против `'5000'` даст отвергнутую подпись. Argus живёт на ноутбуке, который спит и
 * просыпается: уехавшие часы Bybit отвергает по тому же правилу, и это тоже `error`, а не ноль.
 */
const RECV_WINDOW = '5000'

// ── Подпись (чистые функции: проверяются эталоном без сети) ─────────────────────────────────────

/** Строка, которую Bybit требует подписать для GET: timestamp + ключ + recv_window + queryString. */
export function bybitPrehash(p: {
  apiKey: string
  timestamp: string | number
  recvWindow: string | number
  query: string
}): string {
  return `${p.timestamp}${p.apiKey}${p.recvWindow}${p.query}`
}

/**
 * Подпись Bybit v5 — HMAC-SHA256 в НИЖНЕМ регистре hex.
 *
 * Порядок склейки — единственное, что здесь можно перепутать, и ошибка не видна: биржа отвечает
 * HTTP 200 с `retCode: 10004`. Поэтому склейка вынесена отдельно и закреплена эталоном в тесте.
 */
export function bybitSignature(p: {
  apiKey: string
  secret: string
  timestamp: string | number
  recvWindow: string | number
  query: string
}): string {
  return createHmac('sha256', p.secret).update(bybitPrehash(p)).digest('hex')
}

/** Строка, которую OKX требует подписать: timestamp + МЕТОД + путь запроса + тело. */
export function okxPrehash(p: {
  timestamp: string
  method: string
  requestPath: string
  body?: string
}): string {
  return `${p.timestamp}${p.method.toUpperCase()}${p.requestPath}${p.body ?? ''}`
}

/**
 * Подпись OKX v5 — HMAC-SHA256, закодированный в base64 (а не в hex, как у Bybit).
 *
 * `requestPath` — это путь ВМЕСТЕ со строкой запроса: в примере документации подписывается
 * `/api/v5/account/balance?ccy=BTC` целиком. Подписать путь без параметров, а послать с ними —
 * получить `50113 Invalid Sign`.
 */
export function okxSignature(p: {
  secret: string
  timestamp: string
  method: string
  requestPath: string
  body?: string
}): string {
  return createHmac('sha256', p.secret).update(okxPrehash(p)).digest('base64')
}

/** Метка времени OKX: ISO-8601 UTC с миллисекундами. Ровно то, что даёт `toISOString()`. */
export function okxTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

// ── Разбор ответов (чистый: виден в тестах без сети) ────────────────────────────────────────────

/**
 * Число из ответа биржи. Пустая строка, пробел, `null` и мусор дают null, а НЕ ноль.
 *
 * Главная ловушка обоих форматов. Обе биржи присылают числа строками и оставляют `""` там, где
 * значения нет: у Bybit это, например, `availableToBorrow`, у OKX — незаполненный `eqUsd`.
 * `Number('')` равен нулю, и один такой пропуск делает «биржа не сказала» неотличимым от «пусто».
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Код ответа как строка: Bybit шлёт число `0`, OKX — строку `"0"`. Не наш ответ — null. */
function codeOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

/** Текст, который сказала сама биржа. Пустой — значит не сказала ничего. */
function messageOf(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

/**
 * Подсказки к кодам отказа — только те, что подтверждены таблицей документации.
 *
 * Свои пояснения добавлены там, где сообщение биржи ничего не объясняет владельцу, а причина
 * лежит на нашей стороне. Для остальных кодов показываем ТЕКСТ БИРЖИ: выдумывать расшифровку
 * непроверенного кода — то же враньё, только про ошибку.
 */
const BYBIT_HINTS: Record<string, string> = {
  '10003': 'ключ недействителен',
  '10004': 'подпись отвергнута',
  '10005': 'ключу не хватает прав — нужен доступ на чтение счёта',
  '10006': 'превышен лимит запросов',
  '10007': 'аутентификация не пройдена',
  '10010': 'запрос пришёл с IP вне белого списка ключа',
  '10016': 'биржа сообщает о своей внутренней ошибке',
  '10018': 'превышен лимит запросов с этого IP',
  '33004': 'срок жизни ключа истёк'
}

// У OKX проверить удалось лишь часть таблицы, поэтому расшифровок ровно столько же.
// Остальное берётся из поля `msg` самого ответа — оно приходит с биржи и всегда актуально.
const OKX_HINTS: Record<string, string> = {
  '50011': 'превышен лимит запросов',
  '50102': 'метка времени разошлась с часами биржи больше чем на 30 секунд',
  '50105': 'неверная парольная фраза ключа',
  '50111': 'ключ недействителен',
  '50113': 'подпись отвергнута'
}

function refusal(label: string, code: string, hints: Record<string, string>, msg: string): string {
  const why = hints[code] || msg || 'причина не названа'
  return `${label} отказал: ${why} (код ${code})`
}

/** Сначала дорогие монеты, потом крупные по количеству — чтобы главное было первым. */
function sortAssets(assets: ExchangeAsset[]): ExchangeAsset[] {
  return assets.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount || a.symbol.localeCompare(b.symbol))
}

/**
 * Разобрать ответ Bybit v5 `/v5/account/wallet-balance`.
 *
 * null означает «это не ответ Bybit» — тогда решение принимает вызывающий, и оно тоже не «ноль».
 * Ответ с ненулевым `retCode` разбирается в `status: 'error'`: биржа явно сказала «нет», и
 * терять эту причину нельзя, иначе на экране появится пустой счёт вместо «ключ протух».
 */
export function parseBybitBalance(data: unknown, now: number = Date.now()): ExchangeBalance | null {
  if (!data || typeof data !== 'object') return null
  const d = data as { retCode?: unknown; retMsg?: unknown; result?: unknown }
  const code = codeOf(d.retCode)
  if (code === null) return null

  if (code !== '0') {
    return {
      status: 'error',
      assets: [],
      totalUsd: null,
      error: refusal('Bybit', code, BYBIT_HINTS, messageOf(d.retMsg)),
      fetchedAt: now
    }
  }

  const list = (d.result as { list?: unknown } | undefined)?.list
  if (!Array.isArray(list)) return null
  if (list.length === 0) {
    // Успешный ответ без единого счёта — это не «ноль на счету», а «единого торгового счёта нет»
    // (например, аккаунт ещё не переведён в UTA). Показать здесь ноль значит соврать.
    return {
      status: 'error',
      assets: [],
      totalUsd: null,
      error: 'Bybit не вернул ни одного счёта UNIFIED — баланс неизвестен',
      fetchedAt: now
    }
  }

  const assets: ExchangeAsset[] = []
  let sum = 0
  let sumKnown = true
  let complete = true

  for (const entry of list) {
    const e = (entry ?? {}) as { totalEquity?: unknown; coin?: unknown }
    const equity = num(e.totalEquity)
    if (equity === null) sumKnown = false
    else sum += equity

    for (const raw of Array.isArray(e.coin) ? e.coin : []) {
      const c = (raw ?? {}) as { coin?: unknown; walletBalance?: unknown; equity?: unknown; usdValue?: unknown }
      const symbol = typeof c.coin === 'string' && c.coin.trim() ? c.coin.trim() : null
      // Кошельковый баланс — это «сколько монет лежит». `equity` включает нереализованный
      // результат по позициям и на вопрос «сколько у меня монет» отвечает другим числом;
      // берём его только как запасной, если основного поля в ответе нет вовсе.
      const amount = symbol === null ? null : (num(c.walletBalance) ?? num(c.equity))
      if (symbol === null || amount === null) {
        // Строку, которую не удалось прочитать, выбрасывать молча нельзя: список станет неполным,
        // а выглядеть будет как полный. Помечаем весь ответ как partial.
        complete = false
        continue
      }
      // Нулевые строки биржа отдаёт «за компанию» по каждой монете, которой счёт когда-то
      // касался. Это шум, а не деньги: сумма от их пропажи не меняется.
      if (amount === 0) continue
      const usd = num(c.usdValue)
      if (usd === null) complete = false
      assets.push({ symbol, amount, usd })
    }
  }

  const totalUsd = sumKnown ? sum : null
  return {
    status: complete && totalUsd !== null ? 'ok' : 'partial',
    assets: sortAssets(assets),
    totalUsd,
    fetchedAt: now
  }
}

/**
 * Разобрать ответ OKX v5 `/api/v5/account/balance`.
 *
 * У OKX код — СТРОКА (`"0"` при успехе), и сравнение с числовым нулём его не поймает.
 */
export function parseOkxBalance(data: unknown, now: number = Date.now()): ExchangeBalance | null {
  if (!data || typeof data !== 'object') return null
  const d = data as { code?: unknown; msg?: unknown; data?: unknown }
  const code = codeOf(d.code)
  if (code === null) return null

  if (code !== '0') {
    return {
      status: 'error',
      assets: [],
      totalUsd: null,
      error: refusal('OKX', code, OKX_HINTS, messageOf(d.msg)),
      fetchedAt: now
    }
  }

  const rows = d.data
  if (!Array.isArray(rows)) return null
  if (rows.length === 0) {
    return {
      status: 'error',
      assets: [],
      totalUsd: null,
      error: 'OKX не вернул ни одной строки счёта — баланс неизвестен',
      fetchedAt: now
    }
  }

  const assets: ExchangeAsset[] = []
  let sum = 0
  let sumKnown = true
  let complete = true

  for (const row of rows) {
    const r = (row ?? {}) as { totalEq?: unknown; details?: unknown }
    const total = num(r.totalEq)
    if (total === null) sumKnown = false
    else sum += total

    for (const raw of Array.isArray(r.details) ? r.details : []) {
      const c = (raw ?? {}) as { ccy?: unknown; eq?: unknown; eqUsd?: unknown; cashBal?: unknown }
      const symbol = typeof c.ccy === 'string' && c.ccy.trim() ? c.ccy.trim() : null
      // `eq` и `eqUsd` — пара: одно и то же в монете и в долларах. Смешивать `cashBal` с `eqUsd`
      // нельзя, это разные величины; `cashBal` берём только когда `eq` не пришло вовсе.
      const amount = symbol === null ? null : (num(c.eq) ?? num(c.cashBal))
      if (symbol === null || amount === null) {
        complete = false
        continue
      }
      if (amount === 0) continue
      const usd = num(c.eqUsd)
      if (usd === null) complete = false
      assets.push({ symbol, amount, usd })
    }
  }

  const totalUsd = sumKnown ? sum : null
  return {
    status: complete && totalUsd !== null ? 'ok' : 'partial',
    assets: sortAssets(assets),
    totalUsd,
    fetchedAt: now
  }
}

// ── Поход на биржу ──────────────────────────────────────────────────────────────────────────────

/**
 * Убрать ключи из текста, который увидит человек.
 *
 * Не паранойя, а закрытая дыра: сообщение об отказе собирается в том числе из поля биржи
 * (`retMsg`/`msg`), а это чужой текст — в него может попасть эхо нашего запроса. Плюс ошибки
 * `fetch` иногда несут в себе адрес и заголовки. Текст из этого модуля уходит в интерфейс и в
 * базу, поэтому чистка стоит на ЕДИНСТВЕННОМ выходе — там, где ключи ещё известны.
 *
 * Короткие значения не режем: трёхсимвольная парольная фраза встречается в обычных словах, и
 * замена превратила бы сообщение в кашу, ничего при этом не защитив.
 */
export function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text
  for (const s of secrets) {
    if (typeof s === 'string' && s.trim().length >= 4) out = out.split(s.trim()).join('***')
  }
  return out
}

/**
 * Коды, за которыми стоит «биржа сейчас занята», а не «с запросом что-то не так».
 *
 * Повторять имеет смысл только их. Отвергнутая подпись, протухший ключ и нехватка прав от повтора
 * не исправятся — а на лимите запросов лишние попытки его же и продлевают, поэтому повтор идёт
 * с растущей паузой из `resilience.ts`, а не подряд.
 */
const BUSY_CODES: Record<Exchange, ReadonlySet<string>> = {
  bybit: new Set(['10006', '10016', '10018']),
  okx: new Set(['50011'])
}

/** Отказ «занято»: несёт текст биржи и при этом считается поводом повторить. */
class ExchangeBusyError extends RetryableHttpError {
  constructor(message: string) {
    super(429)
    this.name = 'ExchangeBusyError'
    this.message = message
  }
}

/** Имя содержит Timeout — по нему `isRetryable` опознаёт тайм-аут как повод повторить. */
/** Метка «тело оказалось не JSON»: отличает её от настоящего `null` в ответе биржи. */
const NOT_JSON = Symbol('не JSON')

class ExchangeTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExchangeTimeoutError'
  }
}

function rawCode(exchange: Exchange, data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as { retCode?: unknown; code?: unknown }
  return codeOf(exchange === 'bybit' ? d.retCode : d.code)
}

/**
 * Спросить биржу о балансе счёта.
 *
 * Возвращает всегда, никогда не бросает: неизвестность — это `status: 'error'` с человеческим
 * текстом. Нулевым баланс становится ТОЛЬКО после успешного ответа биржи, в котором ноль.
 *
 * `now` подменяется в тестах: метка времени входит в подпись, и без управляемых часов проверить
 * заголовки нечем.
 */
export async function fetchExchangeBalance(
  exchange: Exchange,
  creds: ExchangeCreds,
  now: () => number = Date.now
): Promise<ExchangeBalance> {
  const label = exchange === 'bybit' ? 'Bybit' : 'OKX'
  const apiKey = creds?.apiKey?.trim() ?? ''
  const secret = creds?.secret?.trim() ?? ''
  const passphrase = creds?.passphrase?.trim() ?? ''
  const scrub = (text: string): string => scrubSecrets(text, [apiKey, secret, passphrase])
  const fail = (error: string): ExchangeBalance => ({
    status: 'error',
    assets: [],
    totalUsd: null,
    error: scrub(error),
    fetchedAt: now()
  })

  // Без ключа в сеть не идём вовсе: ответом будет отказ авторизации, и на экране появится
  // ложное «биржа отвергла ключ» вместо честного «ключ не заведён».
  if (!apiKey || !secret) return fail(`${label}: ключ не задан — баланс неизвестен`)
  if (exchange === 'okx' && !passphrase) {
    return fail('OKX: не задана парольная фраза ключа — баланс неизвестен')
  }

  const host = exchange === 'bybit' ? BYBIT_HOST : OKX_HOST
  const service = new URL(host).host

  try {
    const balance = await resilient(
      service,
      async () => {
        const at = now()
        // URL и подпись строятся из ОДНИХ И ТЕХ ЖЕ строк. Разъехавшийся порядок параметров —
        // классическая причина «неверной подписи», которую невозможно увидеть глазами.
        const url =
          exchange === 'bybit' ? `${host}${BYBIT_PATH}?${BYBIT_QUERY}` : `${host}${OKX_PATH}`
        // Тип проставлен явно: без него TypeScript выводит ОБЪЕДИНЕНИЕ двух наборов заголовков,
        // где чужие поля становятся `undefined`, и такой объект уже не является `HeadersInit`.
        const headers: Record<string, string> =
          exchange === 'bybit'
            ? {
                accept: 'application/json',
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-TIMESTAMP': String(at),
                'X-BAPI-RECV-WINDOW': RECV_WINDOW,
                // Тип 2 = HMAC. Так же его шлёт официальный пример Bybit.
                'X-BAPI-SIGN-TYPE': '2',
                'X-BAPI-SIGN': bybitSignature({
                  apiKey,
                  secret,
                  timestamp: at,
                  recvWindow: RECV_WINDOW,
                  query: BYBIT_QUERY
                })
              }
            : {
                accept: 'application/json',
                'OK-ACCESS-KEY': apiKey,
                'OK-ACCESS-TIMESTAMP': okxTimestamp(at),
                'OK-ACCESS-PASSPHRASE': passphrase,
                'OK-ACCESS-SIGN': okxSignature({
                  secret,
                  timestamp: okxTimestamp(at),
                  method: 'GET',
                  requestPath: OKX_PATH
                })
              }

        const controller = new AbortController()
        // Срок общий на весь путь, включая чтение тела. Раньше таймер снимался сразу после
        // заголовков: биржа, приславшая 200 и замолчавшая на теле, оставляла разбор без
        // ограничения — а счета опрашиваются по очереди, поэтому экран «Финансы» переставал
        // обновлять ВСЕ следующие, и после ввода ключей кнопка навсегда оставалась
        // «Проверяю…». Отмена запроса чтение уже полученного тела не прерывает, одной её мало.
        let data: unknown
        let status = 0
        let retryAfter: string | null = null
        try {
          const got = await withDeadline<{ status: number; retryAfter: string | null; data: unknown }>({
            ms: TIMEOUT_MS,
            dispose: () => controller.abort(),
            run: async (gate) => {
              const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
              if (!gate.active()) return
              const status = response.status
              const retryAfterHeader = response.headers?.get('retry-after') ?? null
              // Код ответа — уже доказанный факт, и терять его из-за молчащего тела нельзя.
              // Биржа, отдавшая 401 и замолчавшая, по сроку превращалась в «не ответила»: на
              // экране это «связи нет» вместо «ключ не принят», и владелец чинил бы не то.
              // Тело у неудачного ответа не нужно: вердикт ставит сам код.
              if (!response.ok) {
                gate.settle(() => ({ status, retryAfter: retryAfterHeader, data: NOT_JSON }))
                // Тело неудачного ответа не нужно, но идти не перестаёт: отменяем явно.
                void response.body?.cancel().catch(() => {})
                return
              }
              const body: unknown = await response.json().catch(() => NOT_JSON)
              gate.settle(() => ({ status, retryAfter: retryAfterHeader, data: body }))
            }
          })
          status = got.status
          retryAfter = got.retryAfter
          data = got.data
        } catch (error) {
          if (error instanceof DeadlineError || controller.signal.aborted) {
            throw new ExchangeTimeoutError(`${label} не ответил за 15 с — баланс неизвестен`)
          }
          throw error
        }

        // HTTP-слой: 429 и пятисотки стоит повторить, 4xx — нет. Это ещё не про содержимое:
        // настоящий отказ обеих бирж приезжает с кодом 200.
        const httpFailure = classifyResponse(status, retryAfter)
        if (httpFailure) throw httpFailure

        if (data === NOT_JSON) {
          throw new Error(`${label}: ответ не является JSON — баланс неизвестен`)
        }

        const parsed =
          exchange === 'bybit' ? parseBybitBalance(data, now()) : parseOkxBalance(data, now())
        if (!parsed) throw new Error(`${label}: ответ неизвестного вида — баланс неизвестен`)

        if (parsed.status === 'error') {
          const code = rawCode(exchange, data)
          // «Занято» повторяем, отказ по нашему ключу — нет. Отказ при этом ВОЗВРАЩАЕМ, а не
          // бросаем: для размыкателя цепи биржа здорова, сломан наш ключ, и лишать из-за него
          // данных вторую биржу незачем.
          if (code && BUSY_CODES[exchange].has(code)) throw new ExchangeBusyError(parsed.error ?? '')
        }
        return parsed
      },
      { attempts: 3, baseDelayMs: 600, budgetMs: BUDGET_MS, threshold: 4, cooldownMs: 60_000 }
    )

    return balance.error ? { ...balance, error: scrub(balance.error) } : balance
  } catch (error) {
    // Разомкнутую цепь называем своими словами: иначе владелец думает на свой ключ, тогда как
    // мы намеренно перестали дёргать лежащую биржу.
    const message =
      error instanceof CircuitOpenError
        ? `${label} не отвечает — баланс неизвестен, попробуем позже`
        : error instanceof ExchangeBusyError && error.message
          ? error.message
          : error instanceof PermanentHttpError || error instanceof RetryableHttpError
            ? `${label} ответил HTTP ${error.status} — баланс неизвестен`
            : error instanceof Error && error.message
              ? error.message
              : `${label}: запрос не удался — баланс неизвестен`
    return fail(message)
  }
}

/**
 * С какой биржей работает счёт. null — это не биржа либо она не поддержана.
 *
 * Опознание по названию, а не по отдельному полю: владелец заводит счёт словами («Bybit»,
 * «OKX»), и требовать от него выбирать биржу из списка ради того, что и так написано в названии,
 * значит выдумывать работу. Неопознанное имя просто остаётся ручным счётом — это безопасный
 * исход, в отличие от попытки угадать.
 */
export function exchangeOf(account: { kind: string; institution: string; name: string }): Exchange | null {
  if (account.kind !== 'exchange') return null
  const text = `${account.institution} ${account.name}`.toLowerCase()
  if (text.includes('bybit')) return 'bybit'
  if (text.includes('okx')) return 'okx'
  return null
}
