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
    // Мок отвечает по АДРЕСУ и всегда одинаково: лежащая служба отдаёт 503 на каждый запрос,
    // а не один раз. Одноразовый мок ломался бы о повторы — и ломался бы неверно, показывая
    // ошибку раскладки теста вместо поведения кода.
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(url.includes('coingecko') ? priceResponse() : new Response('', { status: 503 }))
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await walletBalance('BTC', 'bc1qexample000000000000000000000000000000000')
    expect(result).toMatchObject({ status: 'error', native: null, usd: null })
    expect(result.error).toMatch(/503/)
  })

  it('пятисотку ПОВТОРЯЕТ, а отказ по нашему запросу — нет', async () => {
    // Разделение принципиально: временный отказ службы стоит повторить, а неверный адрес
    // не станет верным от того, что мы спросим ещё раз, — и лимит от лишних попыток только
    // продлится.
    const transient = vi.fn((url: string) =>
      Promise.resolve(url.includes('coingecko') ? priceResponse() : new Response('', { status: 503 }))
    )
    vi.stubGlobal('fetch', transient)
    await walletBalance('BTC', 'bc1qexample000000000000000000000000000000000')
    const transientCalls = transient.mock.calls.filter(([u]) => !String(u).includes('coingecko')).length
    expect(transientCalls).toBeGreaterThan(1)

    vi.unstubAllGlobals()
    const permanent = vi.fn((url: string) =>
      Promise.resolve(url.includes('coingecko') ? priceResponse() : new Response('', { status: 404 }))
    )
    vi.stubGlobal('fetch', permanent)
    await walletBalance('BTC', 'bc1qanother00000000000000000000000000000000')
    const permanentCalls = permanent.mock.calls.filter(([u]) => !String(u).includes('coingecko')).length
    expect(permanentCalls).toBe(1)
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
    // Повтор зависшей службы укладывается в общий бюджет: попытка 5с → пауза → попытка 5с →
    // бюджет исчерпан. Худший случай остался прежним (~10.5с), но крутить часы надо дальше.
    await vi.advanceTimersByTimeAsync(15_000)

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
