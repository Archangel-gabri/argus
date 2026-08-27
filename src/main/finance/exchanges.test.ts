// Биржа отличается от блокчейна тем, что умеет ОТКАЗАТЬ, оставшись при этом вежливой: HTTP 200,
// тело с кодом отказа, ни одной монеты в ответе. Наивный разбор такого ответа рисует пустой счёт.
// Поэтому тесты здесь проверяют не то, что код умеет складывать числа, а то, что он не врёт:
// не превращает отказ, обрыв и лимит в ноль, не выдумывает доллары, которых биржа не назвала,
// и не тащит ключ владельца в текст, который увидит человек.
//
// Эталоны подписей посчитаны НЕ этим кодом, а openssl по строкам из документации бирж —
// иначе проверка была бы круговой и подтверждала бы сама себя.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bybitPrehash,
  bybitSignature,
  fetchExchangeBalance,
  okxPrehash,
  okxSignature,
  okxTimestamp,
  parseBybitBalance,
  parseOkxBalance,
  scrubSecrets,
  exchangeOf
} from './exchanges'
import { resetAllBreakers } from '../support/resilience'

beforeEach(() => {
  // Размыкатель цепи — процессное состояние, общее на все тесты: неудачи одного теста иначе
  // копятся и роняют следующий ещё до запроса.
  resetAllBreakers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Ответы, снятые с документации бирж (форма настоящая, числа урезаны) ─────────────────────────

const BYBIT_OK = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    list: [
      {
        accountType: 'UNIFIED',
        totalEquity: '3.31216591',
        totalWalletBalance: '3.00326056',
        totalMarginBalance: '3.00326056',
        totalAvailableBalance: '3.00326056',
        accountLTV: '0',
        coin: [
          {
            coin: 'BTC',
            walletBalance: '0.00002',
            equity: '0.00002',
            usdValue: '2.31216591',
            locked: '0',
            unrealisedPnl: '0',
            availableToWithdraw: '0.00002',
            availableToBorrow: ''
          },
          {
            coin: 'USDT',
            walletBalance: '1',
            equity: '1',
            usdValue: '1.0000123',
            locked: '0',
            unrealisedPnl: '0',
            availableToWithdraw: '1',
            availableToBorrow: ''
          },
          // Монета, которой счёт когда-то касался: нули по всем полям.
          { coin: 'ETH', walletBalance: '0', equity: '0', usdValue: '0', locked: '0', availableToBorrow: '' }
        ]
      }
    ]
  },
  retExtInfo: {},
  time: 1690872862481
}

const OKX_OK = {
  code: '0',
  msg: '',
  data: [
    {
      totalEq: '13601.1',
      isoEq: '0',
      adjEq: '13601.1',
      uTime: '1754300000000',
      details: [
        { ccy: 'BTC', eq: '0.1', eqUsd: '13560.87', availBal: '0.1', cashBal: '0.1', disEq: '13560.87' },
        { ccy: 'USDT', eq: '40.23', eqUsd: '40.23', availBal: '40.23', cashBal: '40.23', disEq: '40.23' }
      ]
    }
  ]
}

const jsonOnce = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ── Подписи ─────────────────────────────────────────────────────────────────────────────────────

describe('подпись Bybit v5', () => {
  // Строка ровно из примера документации Bybit; секрет — выдуманный, но фиксированный.
  const SECRET = '4c6b0d5e9f2a1b8c7d3e6f0a9b2c5d8e' // gitleaks:allow — образец для теста, не ключ
  const input = {
    apiKey: 'XXXXXXXXXX',
    secret: SECRET,
    timestamp: 1658384314791,
    recvWindow: 5000,
    query: 'category=option&symbol=BTC-29JUL22-25000-C'
  }

  it('склеивает строку ровно в порядке «время + ключ + окно + параметры»', () => {
    // Порядок — единственное, что здесь можно перепутать, и биржа об ошибке не скажет ничего
    // внятного: вернёт 200 и retCode 10004. Строка сверена с примером из документации.
    expect(bybitPrehash(input)).toBe('1658384314791XXXXXXXXXX5000category=option&symbol=BTC-29JUL22-25000-C')
  })

  it('совпадает с эталоном, посчитанным вне этого кода', () => {
    // openssl dgst -sha256 -hmac "<secret>" по той же строке.
    expect(bybitSignature(input)).toBe('02e2727e4a44df0330acce41fdc0b1d86203bc390740d37a7808bcf1999f8c2b')
  })

  it('отдаёт hex в нижнем регистре — биржа сравнивает побайтово', () => {
    expect(bybitSignature(input)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('окно «5000» и 5000 дают одну и ту же подпись — иначе тип поля решал бы судьбу запроса', () => {
    expect(bybitSignature({ ...input, recvWindow: '5000' })).toBe(bybitSignature(input))
  })
})

describe('подпись OKX v5', () => {
  // Секрет и метка времени — из примера документации OKX.
  const SECRET = '22582BD0CFF14C41EDBF1AB98506286D' // gitleaks:allow — публичный пример из доков OKX
  const input = {
    secret: SECRET,
    timestamp: '2020-12-08T09:08:57.715Z',
    method: 'GET',
    requestPath: '/api/v5/account/balance?ccy=BTC'
  }

  it('подписывает путь ВМЕСТЕ со строкой запроса', () => {
    // Подписать путь без параметров, а послать с ними — получить 50113 Invalid Sign.
    expect(okxPrehash(input)).toBe('2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=BTC')
  })

  it('совпадает с эталоном, посчитанным вне этого кода, и это base64, а не hex', () => {
    expect(okxSignature(input)).toBe('HiZhvSfMtWJA3uUIVXV3a/bSXNPCWvYFXoGCVS8V4zY=')
  })

  it('метод приводится к верхнему регистру: биржа подписывает GET, а не get', () => {
    expect(okxSignature({ ...input, method: 'get' })).toBe(okxSignature(input))
  })

  it('метка времени — ISO-8601 UTC с миллисекундами', () => {
    expect(okxTimestamp(Date.parse('2026-08-04T09:08:57.715Z'))).toBe('2026-08-04T09:08:57.715Z')
  })
})

// ── Разбор ответов ──────────────────────────────────────────────────────────────────────────────

describe('разбор ответа Bybit', () => {
  it('читает настоящий по форме ответ', () => {
    const b = parseBybitBalance(BYBIT_OK, 1_000)
    expect(b).not.toBeNull()
    expect(b?.status).toBe('ok')
    expect(b?.totalUsd).toBeCloseTo(3.31216591)
    expect(b?.fetchedAt).toBe(1_000)
    expect(b?.assets.map((a) => a.symbol)).toEqual(['BTC', 'USDT'])
    expect(b?.assets[0]).toEqual({ symbol: 'BTC', amount: 0.00002, usd: 2.31216591 })
  })

  it('нулевые строки не показываются, но и сумму не портят', () => {
    // ETH с нулём по всем полям биржа отдаёт «за компанию» — это шум, а не деньги.
    expect(parseBybitBalance(BYBIT_OK)?.assets.some((a) => a.symbol === 'ETH')).toBe(false)
  })

  it('пустая строка вместо цены — это «не оценено», а не «стоит ноль»', () => {
    // Number('') равен нулю, и без явной проверки монета на тысячу долларов стоила бы $0,
    // а весь ответ выглядел бы полным.
    const data = {
      retCode: 0,
      retMsg: 'OK',
      result: { list: [{ accountType: 'UNIFIED', totalEquity: '10', coin: [{ coin: 'XRP', walletBalance: '5', usdValue: '' }] }] }
    }
    const b = parseBybitBalance(data)
    expect(b?.status).toBe('partial')
    expect(b?.assets[0]).toEqual({ symbol: 'XRP', amount: 5, usd: null })
  })

  it('без итоговой оценки счёта доллары не выдумываются', () => {
    const data = { retCode: 0, result: { list: [{ accountType: 'UNIFIED', totalEquity: '', coin: [] }] } }
    const b = parseBybitBalance(data)
    expect(b?.status).toBe('partial')
    expect(b?.totalUsd).toBeNull()
  })

  it('отказ с кодом остаётся отказом, а не пустым счётом', () => {
    const b = parseBybitBalance({ retCode: 10004, retMsg: 'error sign!', result: {} })
    expect(b?.status).toBe('error')
    expect(b?.assets).toEqual([])
    expect(b?.totalUsd).toBeNull()
    expect(b?.error).toContain('10004')
    expect(b?.error).toMatch(/подпись/i)
  })

  it('успешный ответ без единого счёта — это не ноль на счету', () => {
    // Так отвечает аккаунт, не переведённый в единый торговый счёт.
    const b = parseBybitBalance({ retCode: 0, retMsg: 'OK', result: { list: [] } })
    expect(b?.status).toBe('error')
    expect(b?.totalUsd).toBeNull()
  })

  it('доказанный ноль показывается нулём', () => {
    const b = parseBybitBalance({
      retCode: 0,
      retMsg: 'OK',
      result: { list: [{ accountType: 'UNIFIED', totalEquity: '0', coin: [] }] }
    })
    expect(b).toMatchObject({ status: 'ok', totalUsd: 0, assets: [] })
  })

  it('чужой ответ не превращается в баланс', () => {
    expect(parseBybitBalance(null)).toBeNull()
    expect(parseBybitBalance('<html>502 Bad Gateway</html>')).toBeNull()
    expect(parseBybitBalance({ hello: 1 })).toBeNull()
    // Код успеха есть, а тела нет — разобрать нечего, и придумывать тоже нечего.
    expect(parseBybitBalance({ retCode: 0, retMsg: 'OK' })).toBeNull()
  })
})

describe('разбор ответа OKX', () => {
  it('читает настоящий по форме ответ', () => {
    const b = parseOkxBalance(OKX_OK, 2_000)
    expect(b?.status).toBe('ok')
    expect(b?.totalUsd).toBeCloseTo(13601.1)
    expect(b?.fetchedAt).toBe(2_000)
    // Дорогое первым: так владелец видит главное, не читая список.
    expect(b?.assets.map((a) => a.symbol)).toEqual(['BTC', 'USDT'])
    expect(b?.assets[0]).toEqual({ symbol: 'BTC', amount: 0.1, usd: 13560.87 })
  })

  it('код успеха у OKX — СТРОКА, и сравнение с числовым нулём его не поймает', () => {
    expect(parseOkxBalance({ code: 0, msg: '', data: [{ totalEq: '5', details: [] }] })?.status).toBe('ok')
    expect(parseOkxBalance(OKX_OK)?.status).toBe('ok')
  })

  it('отказ по подписи не становится пустым счётом', () => {
    const b = parseOkxBalance({ code: '50113', msg: 'Invalid Sign', data: [] })
    expect(b?.status).toBe('error')
    expect(b?.totalUsd).toBeNull()
    expect(b?.error).toContain('50113')
  })

  it('незнакомый код объясняется словами самой биржи, а не выдумкой', () => {
    // Полную таблицу кодов OKX подтвердить не удалось, поэтому расшифровки есть только у
    // проверенных; для остальных единственный честный источник — поле msg ответа.
    const b = parseOkxBalance({ code: '51000', msg: 'Parameter ccy error', data: [] })
    expect(b?.error).toContain('Parameter ccy error')
    expect(b?.error).toContain('51000')
  })

  it('пустая цена в долларах не обнуляет монету', () => {
    const b = parseOkxBalance({ code: '0', msg: '', data: [{ totalEq: '7', details: [{ ccy: 'TON', eq: '3', eqUsd: '' }] }] })
    expect(b?.status).toBe('partial')
    expect(b?.assets[0]).toEqual({ symbol: 'TON', amount: 3, usd: null })
  })

  it('пустой торговый счёт — это доказанный ноль', () => {
    expect(parseOkxBalance({ code: '0', msg: '', data: [{ totalEq: '0', details: [] }] })).toMatchObject({
      status: 'ok',
      totalUsd: 0,
      assets: []
    })
  })

  it('чужой ответ не превращается в баланс', () => {
    expect(parseOkxBalance(null)).toBeNull()
    expect(parseOkxBalance({ data: [] })).toBeNull()
    expect(parseOkxBalance({ code: '0', msg: '' })).toBeNull()
  })

  it('успех без единой строки счёта не показывается нулём', () => {
    expect(parseOkxBalance({ code: '0', msg: '', data: [] })?.status).toBe('error')
  })
})

// ── Поход на биржу ──────────────────────────────────────────────────────────────────────────────

const BYBIT_CREDS = { apiKey: 'ARGUSKEY', secret: '4c6b0d5e9f2a1b8c7d3e6f0a9b2c5d8e' } // gitleaks:allow — образец
const OKX_CREDS = {
  apiKey: 'okx-key-0001',
  secret: '22582BD0CFF14C41EDBF1AB98506286D', // gitleaks:allow — публичный пример из доков OKX
  passphrase: 'passphrase-0001'
}

describe('поход за балансом', () => {
  it('без ключа в сеть не ходит вовсе', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchExchangeBalance('bybit', { apiKey: '', secret: '' })
    expect(r.status).toBe('error')
    expect(r.totalUsd).toBeNull()
    expect(r.error).toMatch(/ключ не задан/i)
    // Ходить без ключа бессмысленно: ответом был бы отказ авторизации, и владелец увидел бы
    // «биржа отвергла ключ» вместо честного «ключ не заведён».
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('OKX без парольной фразы не спрашивается: у неё ключ из трёх частей', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchExchangeBalance('okx', { apiKey: 'k', secret: 's' })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/парольная фраза/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('шлёт ровно те заголовки, которых требует Bybit, и подписывает то, что посылает', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonOnce(BYBIT_OK)))
    vi.stubGlobal('fetch', fetchMock)

    await fetchExchangeBalance('bybit', BYBIT_CREDS, () => 1754300000000)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED')
    expect(headers['X-BAPI-API-KEY']).toBe('ARGUSKEY')
    expect(headers['X-BAPI-TIMESTAMP']).toBe('1754300000000')
    expect(headers['X-BAPI-RECV-WINDOW']).toBe('5000')
    // Эталон посчитан openssl по строке 1754300000000+ARGUSKEY+5000+accountType=UNIFIED.
    // Проверка ловит главную ошибку: подписали не ту строку, что ушла в адрес запроса.
    expect(headers['X-BAPI-SIGN']).toBe('dad53cda62a8ade6be6fdee26823b34c467520cf7c480a13748481b4842d735e')
  })

  it('шлёт ровно те заголовки, которых требует OKX', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonOnce(OKX_OK)))
    vi.stubGlobal('fetch', fetchMock)
    const at = Date.parse('2026-08-04T09:08:57.715Z')

    await fetchExchangeBalance('okx', OKX_CREDS, () => at)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://www.okx.com/api/v5/account/balance')
    expect(headers['OK-ACCESS-KEY']).toBe(OKX_CREDS.apiKey)
    expect(headers['OK-ACCESS-PASSPHRASE']).toBe(OKX_CREDS.passphrase)
    expect(headers['OK-ACCESS-TIMESTAMP']).toBe('2026-08-04T09:08:57.715Z')
    // Эталон openssl по строке 2026-08-04T09:08:57.715Z + GET + /api/v5/account/balance.
    expect(headers['OK-ACCESS-SIGN']).toBe('6xyJQomYw9bqsqjCjNmRogIiJ8HRg75mhduLYkJlDp0=')
  })

  it('успешный ответ доезжает целиком', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonOnce(BYBIT_OK))))
    const r = await fetchExchangeBalance('bybit', BYBIT_CREDS)
    expect(r.status).toBe('ok')
    expect(r.totalUsd).toBeCloseTo(3.31216591)
    expect(r.assets).toHaveLength(2)
  })

  it('отказ приезжает с HTTP 200 — и всё равно не становится нулём', async () => {
    // Ровно та ловушка, ради которой написан модуль: response.ok === true, а денег в ответе нет.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonOnce({ retCode: 10003, retMsg: 'API key is invalid.', result: {} }))))

    const r = await fetchExchangeBalance('bybit', BYBIT_CREDS)
    expect(r.status).toBe('error')
    expect(r.totalUsd).toBeNull()
    expect(r.assets).toEqual([])
    expect(r.error).toContain('10003')
  })

  it('обрыв сети не превращается в пустой счёт', async () => {
    // Часы поддельные: обрыв повторяется с растущей паузой, и ждать её по-настоящему значило бы
    // держать быстрый прогон ради чужого backoff.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))

    const pending = fetchExchangeBalance('okx', OKX_CREDS)
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(pending).resolves.toMatchObject({ status: 'error', totalUsd: null, assets: [] })
  })

  it('пятисотка биржи не превращается в пустой счёт', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 503 }))))

    const pending = fetchExchangeBalance('bybit', BYBIT_CREDS)
    await vi.advanceTimersByTimeAsync(10_000)
    const r = await pending

    expect(r.status).toBe('error')
    expect(r.error).toMatch(/503/)
    expect(r.totalUsd).toBeNull()
  })

  it('мусор вместо JSON не превращается в пустой счёт', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>502</html>', { status: 200 }))))
    const r = await fetchExchangeBalance('okx', OKX_CREDS)
    expect(r).toMatchObject({ status: 'error', totalUsd: null })
  })

  it('успешный ответ неизвестного вида — тоже неизвестность, а не ноль', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonOnce({ ok: true }))))
    const r = await fetchExchangeBalance('bybit', BYBIT_CREDS)
    expect(r).toMatchObject({ status: 'error', totalUsd: null })
  })

  it('отказ авторизации НЕ повторяется', async () => {
    // Неверный ключ не станет верным от того, что мы спросим ещё раз, а лишние попытки только
    // приближают блокировку ключа.
    const fetchMock = vi.fn(() => Promise.resolve(jsonOnce({ retCode: 10004, retMsg: 'error sign!', result: {} })))
    vi.stubGlobal('fetch', fetchMock)

    const r = await fetchExchangeBalance('bybit', BYBIT_CREDS)
    expect(r.status).toBe('error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('лимит запросов повторяется с паузой — и всё равно кончается честной ошибкой', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonOnce({ retCode: 10006, retMsg: 'Too many visits.', result: {} }))
    )
    vi.stubGlobal('fetch', fetchMock)

    const pending = fetchExchangeBalance('bybit', BYBIT_CREDS)
    await vi.advanceTimersByTimeAsync(10_000)
    const r = await pending

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    expect(r.status).toBe('error')
    expect(r.totalUsd).toBeNull()
    expect(r.error).toContain('10006')
  })

  it('зависшая биржа прерывается и объясняется словами', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          })
      )
    )

    const pending = fetchExchangeBalance('okx', OKX_CREDS)
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(pending).resolves.toMatchObject({ status: 'error', totalUsd: null, assets: [] })
    await expect(pending).resolves.toHaveProperty('error', expect.stringMatching(/не ответил/i))
  })
})

describe('ключ владельца наружу не уходит', () => {
  const secrets = [OKX_CREDS.apiKey, OKX_CREDS.secret, OKX_CREDS.passphrase]

  it('не попадает в текст ошибки, даже если биржа вернула его эхом', async () => {
    // Сообщение об отказе собирается в том числе из поля биржи, а это ЧУЖОЙ текст: в него может
    // приехать эхо нашего запроса. Код взят незнакомый нарочно — у знакомых есть своя расшифровка,
    // и подстановка msg не сработала бы, то есть тест ничего бы не проверил.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonOnce({
            code: '51999',
            msg: `Rejected key=${OKX_CREDS.apiKey} sign-secret=${OKX_CREDS.secret} pass=${OKX_CREDS.passphrase}`,
            data: []
          })
        )
      )
    )

    const r = await fetchExchangeBalance('okx', OKX_CREDS)
    expect(r.status).toBe('error')
    for (const s of secrets) expect(r.error).not.toContain(s)
    expect(r.error).toContain('***')
  })

  it('не попадает в текст ошибки при сетевом сбое', async () => {
    // Ошибки fetch иногда несут в себе адрес и заголовки запроса.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error(`connect ETIMEDOUT (key ${OKX_CREDS.apiKey}, secret ${OKX_CREDS.secret})`)))
    )

    const r = await fetchExchangeBalance('okx', OKX_CREDS)
    for (const s of secrets) expect(r.error).not.toContain(s)
  })

  it('не попадает в журнал: модуль не пишет в консоль вообще', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonOnce({ code: '50113', msg: 'Invalid Sign', data: [] }))))

    await fetchExchangeBalance('okx', OKX_CREDS)
    await fetchExchangeBalance('bybit', BYBIT_CREDS)

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('короткое значение не режет сообщение в кашу', () => {
    // Трёхсимвольная парольная фраза встречается внутри обычных слов: замена испортила бы текст,
    // ничего при этом не защитив.
    expect(scrubSecrets('превышен лимит запросов', ['про'])).toBe('превышен лимит запросов')
    expect(scrubSecrets('ключ SECRETVALUE отвергнут', ['SECRETVALUE'])).toBe('ключ *** отвергнут')
  })
})

describe('опознание биржи по счёту', () => {
  it('находит биржу в названии или в организации', () => {
    expect(exchangeOf({ kind: 'exchange', institution: 'Bybit', name: 'Bybit' })).toBe('bybit')
    expect(exchangeOf({ kind: 'exchange', institution: '', name: 'OKX основной' })).toBe('okx')
  })

  it('банк биржей не становится, даже если так назван', () => {
    // Опрос по ключу биржи применим только к бирже: у счёта другого рода ключа нет и не будет.
    expect(exchangeOf({ kind: 'bank', institution: 'Bybit', name: 'Bybit' })).toBeNull()
  })

  it('незнакомая биржа остаётся ручным счётом, а не угадывается', () => {
    expect(exchangeOf({ kind: 'exchange', institution: 'Kraken', name: 'Kraken' })).toBeNull()
  })
})

describe('срок на весь ответ биржи', () => {
  it('биржа, замолчавшая на теле, не подвешивает опрос остальных счетов', async () => {
    // Счета опрашиваются по очереди. Пока таймер снимался после заголовков, биржа, приславшая
    // 200 и замолчавшая на теле, останавливала весь обход: экран «Финансы» переставал
    // обновлять все следующие счета, а после ввода ключей кнопка навсегда оставалась
    // «Проверяю…».
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: () => new Promise(() => {}) // тело не придёт никогда
      })
    )

    const promise = fetchExchangeBalance('bybit', { apiKey: 'k', secret: 's' })
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await promise

    expect(result.status).toBe('error')
    expect(result.error ?? '').toMatch(/не ответил|15 с/i)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
