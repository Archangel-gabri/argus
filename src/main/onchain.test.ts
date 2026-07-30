import { afterEach, describe, expect, it, vi } from 'vitest'
import { walletBalance } from './onchain'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const priceResponse = (): Response =>
  Response.json({ ethereum: { usd: 2_500 }, bitcoin: { usd: 100_000 }, 'the-open-network': { usd: 3 } })

describe('on-chain баланс: неизвестное не равно нулю', () => {
  it('отличает доказанный нулевой баланс от ошибки RPC', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(priceResponse())
      .mockResolvedValueOnce(Response.json({ error: { code: -32602, message: 'invalid address' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await walletBalance('ETH', '0x0000000000000000000000000000000000000000')

    expect(result).toMatchObject({ status: 'error', native: null, usd: null, symbol: 'ETH' })
    expect(result.error).toMatch(/RPC/i)
  })

  it('не разбирает HTTP 503 как пустой кошелёк', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(priceResponse()).mockResolvedValueOnce(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(walletBalance('BTC', 'bc1qexample000000000000000000000000000000000')).resolves.toMatchObject({
      status: 'error',
      native: null,
      usd: null,
      error: 'HTTP 503 — баланс неизвестен'
    })
  })

  it('прерывает зависший RPC и возвращает явную ошибку', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('coingecko')) return Promise.resolve(priceResponse())
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      })
    )

    const pending = walletBalance('TON', 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      native: null,
      usd: null,
      error: 'Тайм-аут RPC — баланс неизвестен'
    })
  })

  it('сохраняет нативный баланс, если неизвестна только USD-цена', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ result: '0xde0b6b3a7640000' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(walletBalance('ETH', '0x0000000000000000000000000000000000000000')).resolves.toMatchObject({
      status: 'partial',
      native: 1,
      usd: null,
      symbol: 'ETH'
    })
  })

  it('возвращает полный результат только при двух доказанных ответах', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(priceResponse())
      .mockResolvedValueOnce(Response.json({ result: '0x0' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(walletBalance('ETH', '0x0000000000000000000000000000000000000000')).resolves.toMatchObject({
      status: 'ok',
      native: 0,
      usd: 0,
      symbol: 'ETH'
    })
  })
})
