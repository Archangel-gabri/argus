import type { WalletBalance } from './types'

// Keyless, public-endpoint balance lookups. Works from RU (no geofenced exchange APIs).
// Сетевой сбой никогда не становится нулём: нулевой баланс можно показать только
// после успешного ответа RPC.

const RPC_TIMEOUT_MS = 10_000

class RpcTimeoutError extends Error {}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} — баланс неизвестен`)
    try {
      return await response.json()
    } catch {
      throw new Error('Ответ RPC не разобран — баланс неизвестен')
    }
  } catch (error) {
    if (controller.signal.aborted) throw new RpcTimeoutError('Тайм-аут RPC — баланс неизвестен')
    throw error
  } finally {
    clearTimeout(timer)
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
    const message = error instanceof Error && error.message ? error.message : 'Ошибка RPC — баланс неизвестен'
    return { status: 'error', native: null, symbol, usd: null, error: message, updatedAt: Date.now() }
  }
}
