import type { WalletBalance } from './types'

// Keyless, public-endpoint balance lookups. Works from RU (no geofenced exchange APIs).
// Best-effort: any failure returns a zero balance rather than throwing.

async function ethBalance(address: string): Promise<number> {
  const r = await fetch('https://ethereum-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] })
  })
  const j = (await r.json()) as { result?: string }
  return j.result ? parseInt(j.result, 16) / 1e18 : 0
}

async function btcBalance(address: string): Promise<number> {
  const r = await fetch(`https://blockstream.info/api/address/${encodeURIComponent(address)}`)
  const j = (await r.json()) as { chain_stats?: { funded_txo_sum: number; spent_txo_sum: number } }
  const s = j.chain_stats
  return s ? (s.funded_txo_sum - s.spent_txo_sum) / 1e8 : 0
}

async function tonBalance(address: string): Promise<number> {
  const r = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${encodeURIComponent(address)}`)
  const j = (await r.json()) as { result?: string }
  return j.result ? Number(j.result) / 1e9 : 0
}

async function prices(): Promise<Record<string, number>> {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,the-open-network&vs_currencies=usd'
    )
    const j = (await r.json()) as Record<string, { usd?: number }>
    return { ETH: j.ethereum?.usd ?? 0, BTC: j.bitcoin?.usd ?? 0, TON: j['the-open-network']?.usd ?? 0 }
  } catch {
    return {}
  }
}

export async function walletBalance(chain: string, address: string): Promise<WalletBalance> {
  const px = await prices()
  try {
    if (chain === 'ETH') {
      const n = await ethBalance(address)
      return { native: n, symbol: 'ETH', usd: px.ETH ? n * px.ETH : null }
    }
    if (chain === 'BTC') {
      const n = await btcBalance(address)
      return { native: n, symbol: 'BTC', usd: px.BTC ? n * px.BTC : null }
    }
    if (chain === 'TON') {
      const n = await tonBalance(address)
      return { native: n, symbol: 'TON', usd: px.TON ? n * px.TON : null }
    }
  } catch {
    /* network / parse failure → zero */
  }
  return { native: 0, symbol: chain, usd: null }
}
