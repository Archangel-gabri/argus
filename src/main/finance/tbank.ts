// Остатки по карточным счетам Т-Банка — из веб-кабинета владельца.
//
// Публичного API для счетов физлица у Т-Банка нет и не предвидится: то, что называется T-Invest
// API, отдаёт только брокерский портфель (`tinvest.ts`), а карты и накопительные счета в нём не
// видны вовсе. Единственный оставшийся путь — тот же, что с claude.ai и cursor.com: читать
// собственную сессию владельца из его браузера.
//
// ── Границы, раз это банк ──────────────────────────────────────────────────────────────────────
//
// 1. Вход выполняется ВНУТРИ Argus, в собственном постоянном разделе сессии (`bank-session.ts`).
//    Чужой браузер не нужен: раньше куки читались из Brave, и приложение было несамостоятельным.
// 2. Запрос ТОЛЬКО читающий, и ровно один — список счетов. Ни один другой эндпоинт кабинета
//    отсюда не вызывается и не должен: доступ к сессии банка это доступ к деньгам, и
//    единственная защита здесь — узость того, что мы себе позволяем.
// 3. Сессия кабинета живёт минуты, после чего молча не восстанавливается (проверено). Поэтому
//    отказ — норма, а не поломка, и он обязан приводить к «нужен вход», а не к нулю и не к
//    молчаливому сохранению старой цифры как свежей.
// 4. Отсутствие сети — третье состояние, отдельное от первых двух: при обрыве нельзя ни трогать
//    прошлую цифру, ни звать владельца входить заново.

// Здесь НЕТ импорта Electron, и это намеренно: как только модуль тянет `electron`, его нельзя
// проверить обычным тестом — вся логика различения состояний уезжает в непроверяемую часть.
// Транспорт передаётся снаружи (`ipc.ts` даёт настоящий, тест — поддельный).

const HOST = 'www.tbank.ru'
const PATH = '/api/common/v1/accounts_light_ib'

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
  /** `offline` — сети нет; это не про сессию и не повод что-то менять на экране. */
  status: 'ok' | 'no-session' | 'offline' | 'error'
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
 * Спросить остатки у кабинета из собственной сессии Argus.
 *
 * Зависимости подставляются в тестах: настоящий поход в сессию Electron там невозможен.
 */
export interface TbankTransport {
  /** Был ли вход в кабинет вообще. */
  hasSession: () => Promise<boolean>
  /** Идентификатор сессии из куки `psid`. */
  sessionId: () => Promise<string | null>
  request: (url: string, referer: string) => Promise<{ ok: boolean; status: number; body: string; offline?: boolean }>
}

export async function fetchTbankBalance(deps: TbankTransport, now: number = Date.now()): Promise<TbankBalance> {
  const { hasSession, sessionId, request } = deps

  if (!(await hasSession())) {
    return {
      status: 'no-session',
      accounts: [],
      totals: {},
      error: 'Входа в кабинет ещё не было — войдите в окне Argus',
      fetchedAt: now
    }
  }

  const psid = await sessionId()
  if (!psid) {
    return { status: 'no-session', accounts: [], totals: {}, error: 'Сессия кабинета не найдена — войдите заново', fetchedAt: now }
  }

  const query = new URLSearchParams({ ...APP_PARAMS, sessionid: psid }).toString()
  const res = await request(`https://${HOST}${PATH}?${query}`, `https://${HOST}/mybank/`)

  if (res.offline) {
    // Обрыв связи — не отказ банка. Прошлая цифра остаётся как есть, звать владельца входить
    // заново незачем: входить некуда.
    return { status: 'offline', accounts: [], totals: {}, error: 'Нет связи с кабинетом', fetchedAt: now }
  }
  if (!res.ok) {
    return { status: 'error', accounts: [], totals: {}, error: `Кабинет ответил HTTP ${res.status}`, fetchedAt: now }
  }

  try {
    return parseAccounts(JSON.parse(res.body), now)
  } catch {
    return { status: 'error', accounts: [], totals: {}, error: 'Ответ кабинета не разобран', fetchedAt: now }
  }
}
