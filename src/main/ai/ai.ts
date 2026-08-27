import type { AiAccess, AiCheck } from '../types'
import { DeadlineError, withDeadline } from '../../shared/deadline'

/**
 * У кого спрашивать про ключ этой записи.
 *
 * Ключ выписывает тот, к кому он подходит, и адрес его живёт не всегда на самой записи: после
 * перехода на модель «аккаунт → каналы» ключ Codex лежит в КАНАЛЕ аккаунта OpenAI вместе со своим
 * `baseUrl` стороннего роутера. Проверка, смотревшая только на запись, спрашивала api.openai.com,
 * получала 401 и объявляла рабочий ключ протухшим.
 */
export function keyEndpointBase(access: Pick<AiAccess, 'baseUrl' | 'channels'>): string | null {
  if (access.baseUrl) return access.baseUrl
  // Признак «у канала свой ключ» ставится успешной проверкой, а завести его руками негде —
  // значит у канала, только что добавленного владельцем, его не будет никогда. Но адрес он
  // указал сам и не просто так: ключ этого доступа выписан ИМЕННО тем роутером. Поэтому если
  // канала с сохранённым ключом нет, берём адрес у канала, который вообще МОЖЕТ нести ключ.
  //
  // Браузерный канал сюда не годится: у него в адресе веб-интерфейс (claude.ai), ключа там нет
  // и проверять его там бессмысленно.
  const carriesKey = (c: (typeof access.channels)[number]): boolean =>
    c.kind === 'api' || c.kind === 'cli' || c.kind === 'ide'
  const withKey = access.channels.find((c) => c.hasKey && c.baseUrl)
  return (withKey ?? access.channels.find((c) => c.baseUrl && carriesKey(c)))?.baseUrl ?? null
}

// Validity / quota probes for stored AI keys. Keys stay in main; only the verdict crosses IPC.
// OpenRouter exposes real remaining credit; others are validity-only (status from HTTP code).
const CHECK_TIMEOUT_MS = 10_000

class CheckTimeoutError extends Error {}

/**
 * Запрос проверки со сроком на ВЕСЬ ответ, включая тело.
 *
 * Прежняя версия снимала таймер сразу после заголовков и отдавала `Response` наружу. Сервер,
 * приславший заголовки и замолчавший на теле, оставлял `r.json()` без всякого ограничения:
 * значок обновления у аккаунта крутился вечно, а фоновая проверка навсегда занимала признак
 * «идёт проверка» — следующая отбрасывалась, и на экране оставалось старое состояние.
 *
 * Поэтому тело читается ВНУТРИ срока: вызывающий получает уже разобранное значение, а не
 * ответ, который ещё предстоит дочитать.
 */
async function fetchForCheck<T>(
  url: string,
  init: RequestInit = {},
  read?: (r: Response) => Promise<T>
): Promise<{ status: number; ok: boolean; value?: T }> {
  const controller = new AbortController()
  type Out = { status: number; ok: boolean; value?: T }
  try {
    return await withDeadline<Out>({
      ms: CHECK_TIMEOUT_MS,
      what: 'сервис не ответил на проверку ключа',
      // Отмена запроса прерывает ожидание заголовков. Чтение уже полученного тела она НЕ
      // прерывает — поэтому срок здесь общий на весь путь, а не только на запрос.
      dispose: () => controller.abort(),
      run: async (gate) => {
        const r = await fetch(url, { ...init, signal: controller.signal })
        if (!gate.active()) return
        // Известный вердикт нельзя терять из-за молчащего тела. Ответ «401 в заголовках, тело
        // не идёт» — это доказанный отказ ключа, и по сроку он превращался в «сервис не
        // ответил»: владелец видел «проверка не удалась» вместо «ключ не принят».
        if (!r.ok) {
          gate.settle(() => ({ status: r.status, ok: false }))
          // Тело неудачного ответа нам не нужно, но оно продолжает идти: без отмены соединение
          // держится, пока сервер не закончит или пока не сработает сборка мусора.
          void r.body?.cancel().catch(() => {})
          return
        }
        const value = read ? await read(r) : undefined
        gate.settle(() => ({ status: r.status, ok: r.ok, value }))
      }
    })
  } catch (error) {
    // Срок и отмена — одно и то же событие для вызывающего: проверка не состоялась.
    if (error instanceof DeadlineError || controller.signal.aborted) {
      throw new CheckTimeoutError('тайм-аут проверки')
    }
    throw error
  }
}

function knownFailure(status: number): AiCheck | null {
  if (status === 401 || status === 403) return { status: 'invalid' }
  if (status === 429) return { status: 'quota' }
  return null
}

function unknownHttp(status: number): AiCheck {
  return { status: 'error', detail: `HTTP ${status} — результат неизвестен` }
}

/**
 * Проверить ключ.
 *
 * `baseUrl` — не украшение: ключ Codex выписан сторонним роутером и в api.openai.com не действует
 * никогда. Проверка, стучавшаяся туда всегда, объявляла рабочий ключ протухшим и вешала на экран
 * тревогу «перевыпустить». Спрашивать надо у того, кто ключ выдал.
 */
export async function checkAccount(provider: string, apiKey: string, baseUrl?: string | null): Promise<AiCheck> {
  if (!apiKey) return { status: 'nokey' }
  const p = provider.toLowerCase()
  try {
    if (p.includes('openrouter')) {
      const r = await fetchForCheck<unknown>(
        'https://openrouter.ai/api/v1/key',
        { headers: { Authorization: `Bearer ${apiKey}` } },
        // Разбор — часть проверки: сервер, замолчавший на теле, не должен оставлять её висеть.
        (res) => res.json().catch(() => null)
      )
      const failure = knownFailure(r.status)
      if (failure) return failure
      if (!r.ok) return unknownHttp(r.status)
      const payload = r.value
      if (payload === null) {
        return { status: 'error', detail: 'Ответ OpenRouter не разобран — результат неизвестен' }
      }
      if (!payload || typeof payload !== 'object' || !('data' in payload))
        return { status: 'error', detail: 'Ответ OpenRouter не разобран — результат неизвестен' }
      const d = (payload as { data: { limit?: number; usage?: number; limit_remaining?: number } }).data
      if (!d || typeof d !== 'object')
        return { status: 'error', detail: 'Ответ OpenRouter не разобран — результат неизвестен' }
      const remaining =
        d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null)
      return { status: 'valid', remaining: remaining ?? null, usage: d.usage ?? null }
    }
    if (p.includes('anthropic') || p.includes('claude')) {
      // Список моделей — read-only probe: прежний POST /messages создавал реальный запрос,
      // мог расходовать квоту и становился ложной ошибкой после снятия hardcoded-модели.
      const r = await fetchForCheck('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      })
      const failure = knownFailure(r.status)
      if (failure) return failure
      if (r.ok) return { status: 'valid' }
      return unknownHttp(r.status)
    }
    if (p.includes('openai') || p.includes('codex') || p.includes('chatgpt')) {
      const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const r = await fetchForCheck(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      const failure = knownFailure(r.status)
      if (failure) return failure
      if (r.ok) return { status: 'valid' }
      return unknownHttp(r.status)
    }
    if (p.includes('gemini') || p.includes('google')) {
      // Ключ в query string попадает в URL сетевой телеметрии и прокси-логов; Google API
      // принимает тот же credential в заголовке, где он не становится частью адреса.
      const r = await fetchForCheck('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': apiKey }
      })
      const failure = knownFailure(r.status)
      if (failure || r.status === 400) return failure ?? { status: 'invalid' }
      if (r.ok) return { status: 'valid' }
      return unknownHttp(r.status)
    }
    return { status: 'error', detail: 'Автопроверка для провайдера недоступна' }
  } catch (e) {
    const detail = e instanceof CheckTimeoutError ? e.message : (e as Error).message || 'неизвестная ошибка'
    return { status: 'error', detail: `Сеть: ${detail}` }
  }
}
