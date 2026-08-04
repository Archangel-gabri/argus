// Портфель Т-Инвестиций по токену «только чтение».
//
// Это единственный российский счёт владельца, который умеет отвечать сам: у карточных счетов
// Сбербанка и Т-Банка публичного API не существует вовсе, и остаток там вписывается руками.
//
// ── Про сертификат, и почему это отдельный разговор ────────────────────────────────────────────
//
// `invest-public-api.tbank.ru` работает по сертификату, выданному государственным удостоверяющим
// центром Минцифры («Russian Trusted Root CA»). В системном хранилище доверенных корней его нет,
// поэтому обычный запрос обрывается на проверке TLS — именно так это и выглядело: соединение не
// устанавливалось, хотя сам сайт tbank.ru открывался (у него сертификат Let's Encrypt).
//
// Прописать этот корень в систему было бы неправильно: государственный УЦ технически способен
// выписать сертификат на ЛЮБОЙ домен, и, доверившись ему глобально, мы разрешили бы подменять
// любой сайт для всей машины. Поэтому корень лежит рядом с приложением и используется РОВНО для
// запросов к этому одному хосту: своё TLS-соединение со своим списком доверия. Всё остальное в
// приложении продолжает проверяться системным хранилищем.
//
// Тот же приём, что с сертификатом агента трансляции: доверие сужается до одного адресата, а не
// расширяется до всего интернета.
//
// Контракт API — https://github.com/RussianInvestments/investAPI (operations.proto, common.proto).

import { request as httpsRequest, Agent } from 'node:https'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const HOST = 'invest-public-api.tbank.ru'
const BASE = `/rest/tinkoff.public.invest.api.contract.v1`
const TIMEOUT_MS = 20_000

export interface TinvestAccount {
  id: string
  name: string
  /** Открыт ли счёт: закрытые и новые в деньги не считаются. */
  open: boolean
}

export interface TinvestPortfolio {
  status: 'ok' | 'error'
  /** Общая стоимость портфеля. null — биржа не назвала. */
  total: number | null
  currency: string
  /** Сколько счетов сложилось в эту сумму. */
  accounts: number
  error?: string
  fetchedAt: number
}

/**
 * Значение денег из контракта: целая часть строкой, дробная — в миллиардных долях.
 *
 * Две ловушки, обе тихие. Первая: `units` в JSON приходит СТРОКОЙ (в контракте это int64), и
 * `units + nano / 1e9` без преобразования даёт склейку строк — «100» превращается в «1000.5».
 * Вторая: у отрицательной суммы отрицательны ОБА поля, поэтому складывать их надо как есть, а не
 * брать модуль дробной части.
 */
export function moneyValue(v: unknown): { amount: number; currency: string } | null {
  if (!v || typeof v !== 'object') return null
  const m = v as { units?: unknown; nano?: unknown; currency?: unknown }
  const units = typeof m.units === 'string' ? Number(m.units) : typeof m.units === 'number' ? m.units : null
  if (units === null || !Number.isFinite(units)) return null
  const nano = typeof m.nano === 'number' && Number.isFinite(m.nano) ? m.nano : 0
  return {
    amount: units + nano / 1e9,
    currency: typeof m.currency === 'string' && m.currency ? m.currency.toUpperCase() : 'RUB'
  }
}

/** Счета из ответа UsersService/GetAccounts. */
export function parseAccounts(data: unknown): TinvestAccount[] {
  const list = (data as { accounts?: unknown })?.accounts
  if (!Array.isArray(list)) return []
  const out: TinvestAccount[] = []
  for (const raw of list) {
    const a = raw as { id?: unknown; name?: unknown; status?: unknown }
    if (typeof a.id !== 'string' || !a.id) continue
    out.push({
      id: a.id,
      name: typeof a.name === 'string' ? a.name : a.id,
      // Закрытый счёт продолжает возвращаться списком, и его портфель — пустой ноль.
      // Сложить его с открытым значит занизить итог без единого признака ошибки.
      open: a.status === 'ACCOUNT_STATUS_OPEN'
    })
  }
  return out
}

/** Общая стоимость портфеля из ответа OperationsService/GetPortfolio. */
export function parsePortfolioTotal(data: unknown): { amount: number; currency: string } | null {
  const total = (data as { totalAmountPortfolio?: unknown })?.totalAmountPortfolio
  return moneyValue(total)
}

/** Где лежит корень государственного УЦ. Рядом с приложением — и в сборке, и в исходниках. */
function caPath(): string | null {
  const candidates: string[] = []
  try {
    candidates.push(join(process.resourcesPath, 'ca', 'russian-trusted-ca.pem'))
  } catch {
    /* вне собранного приложения ресурсов нет */
  }
  try {
    candidates.push(join(app.getAppPath(), 'resources', 'ca', 'russian-trusted-ca.pem'))
  } catch {
    /* путь приложения недоступен */
  }
  candidates.push(join(process.cwd(), 'resources', 'ca', 'russian-trusted-ca.pem'))
  return candidates.find((p) => existsSync(p)) ?? null
}

let cachedAgent: Agent | null = null

function agent(): Agent | null {
  if (cachedAgent) return cachedAgent
  const path = caPath()
  if (!path) return null
  try {
    // Свой список доверия ТОЛЬКО для этого соединения. Системное хранилище не трогается, и
    // государственный корень не получает права подтверждать что-либо ещё.
    cachedAgent = new Agent({ ca: readFileSync(path), keepAlive: false })
    return cachedAgent
  } catch {
    return null
  }
}

interface CallResult {
  ok: boolean
  data?: unknown
  error?: string
}

/** Один вызов REST-обёртки контракта. Всегда POST с JSON-телом — так устроен сам API. */
function call(method: string, token: string, body: unknown): Promise<CallResult> {
  const ca = agent()
  if (!ca) return Promise.resolve({ ok: false, error: 'Нет корневого сертификата Минцифры — соединение не проверить' })

  return new Promise((resolve) => {
    const payload = JSON.stringify(body ?? {})
    const req = httpsRequest(
      {
        host: HOST,
        path: `${BASE}/${method}`,
        method: 'POST',
        agent: ca,
        timeout: TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
          if ((res.statusCode ?? 0) >= 400) {
            // Причину отказа говорит сам сервис: «токен недействителен» и «нет прав» — разные
            // беды, и подменять их общим «не получилось» значит заставить гадать.
            const message = (parsed as { message?: unknown })?.message
            resolve({ ok: false, error: typeof message === 'string' ? message : `HTTP ${res.statusCode}` })
            return
          }
          resolve({ ok: true, data: parsed })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'Т-Инвестиции не ответили за 20 секунд' })
    })
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.write(payload)
    req.end()
  })
}

/**
 * Спросить портфель по токену.
 *
 * Считаются ОТКРЫТЫЕ счета: у закрытого портфель пустой, и сложение с ним занижает итог молча.
 * Разные валюты не сводятся: складывается только то, что совпадает с валютой ПЕРВОГО открытого
 * счёта, а она же возвращается вместе с суммой — вызывающий обязан сверить её со своей записью.
 * Придумывать курс здесь не наше дело.
 */
export async function fetchTinvestPortfolio(token: string, now: number = Date.now()): Promise<TinvestPortfolio> {
  if (!token.trim()) return { status: 'error', total: null, currency: 'RUB', accounts: 0, error: 'Токен не задан', fetchedAt: now }

  const accountsRes = await call('UsersService/GetAccounts', token, {})
  if (!accountsRes.ok)
    return { status: 'error', total: null, currency: 'RUB', accounts: 0, error: accountsRes.error, fetchedAt: now }

  const accounts = parseAccounts(accountsRes.data).filter((a) => a.open)
  if (accounts.length === 0)
    return { status: 'error', total: null, currency: 'RUB', accounts: 0, error: 'Открытых счетов нет', fetchedAt: now }

  let total = 0
  let counted = 0
  let currency = 'RUB'
  for (const account of accounts) {
    const res = await call('OperationsService/GetPortfolio', token, { accountId: account.id })
    if (!res.ok) continue
    const value = parsePortfolioTotal(res.data)
    if (!value) continue
    // Складываем только однородное: смешивать валюты по выдуманному курсу нельзя.
    if (counted === 0) currency = value.currency
    else if (value.currency !== currency) continue
    total += value.amount
    counted++
  }

  if (counted === 0)
    return { status: 'error', total: null, currency, accounts: accounts.length, error: 'Портфель не прочитан', fetchedAt: now }

  return { status: 'ok', total: Math.round(total * 100) / 100, currency, accounts: counted, fetchedAt: now }
}
