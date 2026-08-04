// Остатки по карточным счетам Т-Банка — из веб-кабинета владельца.
//
// Публичного API для счетов физлица у Т-Банка нет и не предвидится: то, что называется T-Invest
// API, отдаёт только брокерский портфель (`tinvest.ts`), а карты и накопительные счета в нём не
// видны вовсе. Единственный оставшийся путь — тот же, что с claude.ai и cursor.com: читать
// собственную сессию владельца из его браузера.
//
// ── Чем это отличается от квоты Claude ─────────────────────────────────────────────────────────
//
// Тем, что это банк, и об этом надо сказать прямо.
//
// 1. Отправляются ВСЕ куки домена, а не одна кука сессии: кабинет отвергает запрос, в котором
//    есть только идентификатор сессии (`INSUFFICIENT_PRIVILEGES`) — проверено. Это ровно тот
//    набор, который браузер и так шлёт этому хосту, но набор большой, и делать вид, что мы взяли
//    «только нужное», неправильно.
// 2. Ничего не сохраняется: куки читаются в момент запроса, живут в памяти main и туда же
//    исчезают. В хранилище Argus не попадает ни одна из них.
// 3. Запрос ТОЛЬКО читающий. Ни один эндпоинт кабинета, кроме списка счетов, отсюда не
//    вызывается, и никогда не должен: доступ к сессии банка — это доступ к деньгам, и
//    единственная защита здесь — узость того, что мы себе позволяем.
// 4. Сессия кабинета живёт минуты. Поэтому отказ — это норма, а не поломка, и он обязан
//    приводить к «остаток устарел», а не к нулю и не к молчаливому сохранению старой цифры как
//    свежей.

import { cookieHeader, readAllCookies } from './browser-cookies'

const HOST = 'www.tbank.ru'
const PATH = '/api/common/v1/accounts_light_ib'
const TIMEOUT_MS = 20_000

/** Параметры, которыми представляется сам кабинет. Без них запрос отвергается. */
const APP_PARAMS = {
  appName: 'supreme',
  appVersion: '0.0.1',
  platform: 'web',
  origin: 'web,ib5,platform'
}

export interface TbankAccount {
  name: string
  /** Тип из ответа: Current — карточный, Saving — накопительный. */
  type: string
  amount: number
  currency: string
}

export interface TbankBalance {
  status: 'ok' | 'no-session' | 'error'
  accounts: TbankAccount[]
  /** Суммы по валютам: разные валюты не сводятся по выдуманному курсу. */
  totals: Record<string, number>
  error?: string
  fetchedAt: number
}

/**
 * Разобрать ответ кабинета.
 *
 * `resultCode` важнее HTTP-кода: протухшая сессия приезжает с HTTP 200 и словом
 * `INSUFFICIENT_PRIVILEGES` в теле. Если смотреть только на HTTP, это выглядит как счёт без
 * денег — то есть как ноль на экране вместо «войдите заново».
 */
export function parseAccounts(data: unknown, now: number = Date.now()): TbankBalance {
  const d = data as { resultCode?: unknown; payload?: unknown } | null
  const code = typeof d?.resultCode === 'string' ? d.resultCode : ''

  if (code && code !== 'OK') {
    const expired = code === 'INSUFFICIENT_PRIVILEGES' || code === 'NO_SESSION' || code === 'SESSION_EXPIRED'
    return {
      status: expired ? 'no-session' : 'error',
      accounts: [],
      totals: {},
      error: expired ? 'Сессия кабинета истекла — войдите в т-банк.ру заново' : `Кабинет ответил ${code}`,
      fetchedAt: now
    }
  }

  const list = d?.payload
  if (!Array.isArray(list)) {
    return { status: 'error', accounts: [], totals: {}, error: 'Ответ кабинета не разобран', fetchedAt: now }
  }

  const accounts: TbankAccount[] = []
  const totals: Record<string, number> = {}
  for (const raw of list) {
    const a = raw as {
      name?: unknown
      accountType?: unknown
      moneyAmount?: { value?: unknown; currency?: { name?: unknown } }
    }
    const money = a.moneyAmount
    const value = typeof money?.value === 'number' ? money.value : null
    // Счёт без суммы пропускаем: ноль здесь означал бы «пусто», а мы просто не увидели цифру.
    if (value === null) continue
    const currency = typeof money?.currency?.name === 'string' ? money.currency.name.toUpperCase() : 'RUB'
    accounts.push({
      name: typeof a.name === 'string' ? a.name : 'счёт',
      type: typeof a.accountType === 'string' ? a.accountType : '',
      amount: value,
      currency
    })
    totals[currency] = Math.round(((totals[currency] ?? 0) + value) * 100) / 100
  }

  if (accounts.length === 0) {
    return { status: 'error', accounts: [], totals: {}, error: 'Счетов с суммой в ответе нет', fetchedAt: now }
  }
  return { status: 'ok', accounts, totals, fetchedAt: now }
}

/**
 * Спросить остатки у кабинета.
 *
 * `cookies` подставляется в тестах: настоящий поход в базу браузера там не нужен и невозможен.
 */
export async function fetchTbankBalance(
  cookies: (domain: string) => Record<string, string> = readAllCookies,
  now: number = Date.now()
): Promise<TbankBalance> {
  const jar = cookies('tbank.ru')
  // Без куки сессии запрос бессмыслен: ответ будет отказом, а на экране появится «кабинет
  // отверг», хотя честный ответ — «в браузере не залогинены».
  if (!jar.psid) {
    return {
      status: 'no-session',
      accounts: [],
      totals: {},
      error: 'В браузере нет сессии т-банк.ру — войдите в кабинет',
      fetchedAt: now
    }
  }

  const query = new URLSearchParams({ ...APP_PARAMS, sessionid: jar.psid }).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`https://${HOST}${PATH}?${query}`, {
      headers: {
        cookie: cookieHeader(jar),
        referer: `https://${HOST}/mybank/`,
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
      },
      signal: controller.signal
    })
    if (!r.ok) {
      return { status: 'error', accounts: [], totals: {}, error: `Кабинет ответил HTTP ${r.status}`, fetchedAt: now }
    }
    return parseAccounts(await r.json(), now)
  } catch {
    return { status: 'error', accounts: [], totals: {}, error: 'Кабинет не ответил', fetchedAt: now }
  } finally {
    clearTimeout(timer)
  }
}
