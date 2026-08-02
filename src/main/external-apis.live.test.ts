// Договор с внешними службами: проверяем, что они всё ещё отвечают тем, на что мы рассчитываем.
//
// Это единственный класс поломок, который нельзя поймать ни фикстурами, ни моками: чужой
// сервис меняет формат или просто умирает, а у нас всё зелёное. В этом проекте так уже было
// дважды — Clearbit закрылся в декабре 2025 и логотипы хостеров пропали, а llamarpc вместо
// JSON начал отдавать HTML, и баланс кошелька читался как ноль.
//
// Поэтому набор ОТДЕЛЬНЫЙ и в обычный прогон не входит: `npm run test:live`. Он ходит в сеть,
// зависит от чужой доступности и падать в общем гейте не должен — красный тест по вине чужого
// сервиса быстро приучает не смотреть на результат.
//
// Все запросы — ЧТЕНИЕ и без учётных данных. Ключей здесь нет и быть не может.
import { describe, it, expect } from 'vitest'

const LIVE = process.env.ARGUS_LIVE === '1'
const run = LIVE ? describe : describe.skip

const get = async (url: string, ms = 12_000): Promise<Response> => {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    return await fetch(url, { signal: c.signal })
  } finally {
    clearTimeout(t)
  }
}

run('гео по IP — ipwho.is', () => {
  it('отвечает JSON с полями, которые мы читаем', async () => {
    // Публичный адрес Cloudflare: свой флот сюда не подставляем даже в живом наборе.
    const r = await get('https://ipwho.is/1.1.1.1?fields=success,message,country,country_code,city,connection,flag')
    expect(r.ok).toBe(true)
    const j = (await r.json()) as Record<string, unknown>
    expect(j.success).toBe(true)
    // Ровно те поля, которые разбирает net.ts. Пропажа любого — тихая потеря страны и хостера.
    expect(typeof j.country).toBe('string')
    expect(typeof j.country_code).toBe('string')
    expect(j.flag).toBeTypeOf('object')
    expect(j.connection).toBeTypeOf('object')
  })
})

run('курсы — CoinGecko', () => {
  it('отдаёт цены всех трёх монет в долларах', async () => {
    const r = await get(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,the-open-network&vs_currencies=usd'
    )
    expect(r.ok).toBe(true)
    const j = (await r.json()) as Record<string, { usd?: number }>
    for (const coin of ['ethereum', 'bitcoin', 'the-open-network']) {
      expect(j[coin]?.usd, `нет цены для ${coin}`).toBeTypeOf('number')
      expect(j[coin].usd).toBeGreaterThan(0)
    }
  })
})

run('баланс BTC — blockstream', () => {
  it('отдаёт JSON, а не HTML, и считает статистику', async () => {
    // Кошелёк Genesis-блока: публичный, вечный, ничей приватностью не жертвуем.
    const r = await get('https://blockstream.info/api/address/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')
    expect(r.ok).toBe(true)
    expect(r.headers.get('content-type')).toContain('json')
    const j = (await r.json()) as { chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number } }
    expect(j.chain_stats?.funded_txo_sum).toBeTypeOf('number')
    expect(j.chain_stats?.spent_txo_sum).toBeTypeOf('number')
  })
})

run('баланс ETH — publicnode', () => {
  it('отвечает на JSON-RPC, а не отдаёт страницу', async () => {
    // Именно здесь и был подвох: прежний узел (llamarpc) начал отдавать HTML, и разбор
    // молча превращался в нулевой баланс.
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 12_000)
    let r: Response
    try {
      r = await fetch('https://ethereum-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
        signal: c.signal
      })
    } finally {
      clearTimeout(t)
    }
    expect(r.ok).toBe(true)
    expect(r.headers.get('content-type')).toContain('json')
    const j = (await r.json()) as { result?: string }
    expect(j.result).toMatch(/^0x[0-9a-f]+$/i)
  })
})

run('логотипы хостеров — Google s2', () => {
  it('отдаёт картинку, а не заглушку-ошибку', async () => {
    // Clearbit закрылся 2025-12-01, и логотипы отвалились молча. Заменивший его источник
    // проверяем так же — иначе повторится ровно то же самое.
    const r = await get('https://www.google.com/s2/favicons?domain=hetzner.com&sz=128')
    expect(r.ok).toBe(true)
    expect(r.headers.get('content-type')).toContain('image')
    const buf = await r.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(100)
  })
})

run('TON — toncenter', () => {
  it('отвечает ok и числовым балансом в строке', async () => {
    const r = await get(
      // Публичный адрес TON Foundation — постоянный и ничей приватностью не жертвует.
      'https://toncenter.com/api/v2/getAddressBalance?address=EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'
    )
    // Публичный узел бывает под лимитом — это не поломка договора, а отказ в обслуживании.
    if (r.status === 429) return
    expect(r.ok).toBe(true)
    const j = (await r.json()) as { ok?: boolean; result?: string }
    expect(j.ok).toBe(true)
    expect(String(j.result)).toMatch(/^-?\d+$/)
  })
})

if (!LIVE) {
  describe('живые проверки', () => {
    it('пропущены: набор ходит в сеть и запускается отдельно (npm run test:live)', () => {
      expect(LIVE).toBe(false)
    })
  })
}
