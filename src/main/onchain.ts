import type { WalletBalance } from './types'
import { resilient, classifyResponse, CircuitOpenError } from './resilience'

// Keyless, public-endpoint balance lookups. Works from RU (no geofenced exchange APIs).
// Сетевой сбой никогда не становится нулём: нулевой баланс можно показать только
// после успешного ответа RPC.

// Таймаут ОДНОЙ попытки и потолок на весь поход, включая повторы и паузы.
//
// Числа подобраны так, чтобы появление повторов НЕ УДЛИНИЛО худший случай. Раньше зависшая
// служба стоила ровно 10 секунд. Сейчас: попытка 5с → пауза 0.5с → попытка 5с → бюджет
// исчерпан, отказ на 10.5 секунде. То есть человек ждёт столько же, а вот быстрый отказ
// (429 или пятисотка приходят мгновенно) успевает получить все три попытки.
const RPC_TIMEOUT_MS = 5_000
const RPC_BUDGET_MS = 11_000

class RpcTimeoutError extends Error {}

/**
 * Один поход в публичный RPC — с повторами и размыкателем цепи.
 *
 * Все эти службы бесплатные и публичные: временный отказ и лимит запросов у них норма, а не
 * исключение. Раньше любая заминка означала «баланс не показан», и владелец видел пустое место
 * там, где были деньги.
 *
 * Повтор здесь безопасен по построению: каждый вызов — ЧТЕНИЕ, ничего не создаёт и не списывает.
 * Если однажды появится вызов, который что-то меняет, заворачивать его сюда нельзя.
 *
 * Размыкатель у каждой службы свой: лежащий CoinGecko не должен лишать нас балансов из
 * blockstream. И разомкнутая цепь бросает — она НИКОГДА не подставляет ноль вместо неизвестности.
 */
async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const service = serviceOf(url)
  return resilient(
    service,
    async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      try {
        const response = await fetch(url, { ...init, signal: controller.signal })
        // Классификация решает, повторять ли: 429 и пятисотки — да, 400/404 — нет.
        const failure = classifyResponse(response.status, response.headers?.get('retry-after'))
        if (failure) throw failure
        try {
          // `json()` типизирован как any — сузить его здесь важнее, чем в месте разбора:
          // дальше значение уходит в парсеры, ожидающие unknown.
          return (await response.json()) as unknown
        } catch {
          throw new Error('Ответ RPC не разобран — баланс неизвестен')
        }
      } catch (error) {
        if (controller.signal.aborted) throw new RpcTimeoutError('Тайм-аут RPC — баланс неизвестен')
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
    { attempts: 3, baseDelayMs: 500, budgetMs: RPC_BUDGET_MS, threshold: 4, cooldownMs: 60_000 }
  )
}

/** Имя службы для размыкателя — по хосту: у каждой свой запас прочности и свои лимиты. */
function serviceOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'неизвестная-служба'
  }
}

async function ethBalance(address: string): Promise<number> {
  const payload = (await fetchJson('https://ethereum-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] })
  })) as { result?: unknown; error?: { code?: unknown; message?: unknown } }
  if (payload.error) throw new Error(`RPC отклонил запрос — баланс неизвестен`)
  if (typeof payload.result !== 'string' || !/^0x[0-9a-f]+$/i.test(payload.result))
    throw new Error('Ответ RPC не содержит баланс')
  return Number(BigInt(payload.result)) / 1e18
}

async function btcBalance(address: string): Promise<number> {
  const j = (await fetchJson(`https://blockstream.info/api/address/${encodeURIComponent(address)}`)) as {
    chain_stats?: { funded_txo_sum?: unknown; spent_txo_sum?: unknown }
  }
  const s = j.chain_stats
  if (!s || typeof s.funded_txo_sum !== 'number' || typeof s.spent_txo_sum !== 'number')
    throw new Error('Ответ RPC не содержит баланс')
  return (s.funded_txo_sum - s.spent_txo_sum) / 1e8
}

async function tonBalance(address: string): Promise<number> {
  const j = (await fetchJson(
    `https://toncenter.com/api/v2/getAddressBalance?address=${encodeURIComponent(address)}`
  )) as { ok?: unknown; result?: unknown; error?: unknown }
  if (j.ok === false || j.error) throw new Error('RPC отклонил запрос — баланс неизвестен')
  if (typeof j.result !== 'string' || !/^\d+$/.test(j.result))
    throw new Error('Ответ RPC не содержит баланс')
  return Number(BigInt(j.result)) / 1e9
}

async function prices(): Promise<Record<string, number> | null> {
  try {
    const j = (await fetchJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,the-open-network&vs_currencies=usd'
    )) as Record<string, { usd?: unknown }>
    const result: Record<string, number> = {}
    if (typeof j.ethereum?.usd === 'number') result.ETH = j.ethereum.usd
    if (typeof j.bitcoin?.usd === 'number') result.BTC = j.bitcoin.usd
    if (typeof j['the-open-network']?.usd === 'number') result.TON = j['the-open-network'].usd
    return result
  } catch {
    return null
  }
}

export async function walletBalance(chain: string, address: string): Promise<WalletBalance> {
  const symbol = chain.toUpperCase()
  const priceRequest = prices()
  try {
    const native =
      symbol === 'ETH'
        ? await ethBalance(address)
        : symbol === 'BTC'
          ? await btcBalance(address)
          : symbol === 'TON'
            ? await tonBalance(address)
            : null
    if (native === null) throw new Error(`Сеть ${symbol} не поддерживается`)
    const px = await priceRequest
    const usdPrice = px?.[symbol]
    const updatedAt = Date.now()
    if (typeof usdPrice !== 'number') {
      return { status: 'partial', native, symbol, usd: null, updatedAt, error: 'USD-цена неизвестна' }
    }
    return { status: 'ok', native, symbol, usd: native * usdPrice, updatedAt }
  } catch (error) {
    // priceRequest уже имеет catch внутри, поэтому не оставит unhandled rejection.
    //
    // Разомкнутую цепь называем своими словами. Иначе владелец видит «ошибка RPC» и думает на
    // свой кошелёк или на свою сеть, тогда как на самом деле лежит чужая служба и мы намеренно
    // перестали её дёргать. Баланс при этом остаётся null — нулём он не станет никогда.
    const message =
      error instanceof CircuitOpenError
        ? `${error.service} не отвечает — баланс неизвестен, попробуем позже`
        : error instanceof Error && error.message
          ? error.message
          : 'Ошибка RPC — баланс неизвестен'
    return { status: 'error', native: null, symbol, usd: null, error: message, updatedAt: Date.now() }
  }
}
