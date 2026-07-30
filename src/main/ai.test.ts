import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAccount } from './ai'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('проверка AI-доступа', () => {
  it('проверяет Anthropic чтением списка моделей, не создавая оплачиваемое сообщение', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkAccount('anthropic', 'test-secret')).resolves.toEqual({ status: 'valid' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.headers).toMatchObject({ 'x-api-key': 'test-secret' })
  })

  it('передаёт Gemini key только заголовком, а не частью URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkAccount('gemini', 'query-unsafe-secret')).resolves.toEqual({ status: 'valid' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(url).not.toContain('query-unsafe-secret')
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'query-unsafe-secret' })
  })

  it.each([
    [401, { status: 'invalid' }],
    [403, { status: 'invalid' }],
    [429, { status: 'quota' }]
  ] as const)('отличает auth/quota: HTTP %i', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))

    await expect(checkAccount('openai', 'test-secret')).resolves.toEqual(expected)
  })

  it('не выдаёт неизвестный HTTP-ответ за неверный ключ', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    await expect(checkAccount('openai', 'test-secret')).resolves.toEqual({
      status: 'error',
      detail: 'HTTP 503 — результат неизвестен'
    })
  })

  it('не называет сломанный успешный ответ сетевым сбоем или нулевым кредитом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{broken', { status: 200 })))

    await expect(checkAccount('openrouter', 'test-secret')).resolves.toEqual({
      status: 'error',
      detail: 'Ответ OpenRouter не разобран — результат неизвестен'
    })
  })

  it('отличает сетевой сбой от отказа авторизации', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await expect(checkAccount('openai', 'test-secret')).resolves.toEqual({
      status: 'error',
      detail: 'Сеть: fetch failed'
    })
  })

  it('прерывает зависшую проверку по тайм-ауту', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      )
    )

    const result = checkAccount('openai', 'test-secret')
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(result).resolves.toEqual({ status: 'error', detail: 'Сеть: тайм-аут проверки' })
  })

  it('говорит «проверка недоступна», а не «ошибка ключа», для неподдерживаемого провайдера', async () => {
    await expect(checkAccount('groq', 'test-secret')).resolves.toEqual({
      status: 'error',
      detail: 'Автопроверка для провайдера недоступна'
    })
  })
})
