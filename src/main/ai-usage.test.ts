import { describe, expect, it } from 'vitest'
import { localDate, parseClaudeLine, parseCodexLine, type CodexState } from './ai-usage'

// Образцы — сокращённые, но структурно точные копии реальных строк из логов на машине
// владельца. Именно на них ловятся ошибки разбора: выдуманный формат проверяет только
// собственные ожидания.

const claudeLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-30T15:50:39.343Z',
    requestId: 'req_011CdYWM2WmJkcLqWysoKUcD',
    uuid: 'ec294db2-0000-0000-0000-000000000000',
    isSidechain: false,
    message: {
      id: 'msg_011CdYWM3a1vjpfp4JYjimJY',
      model: 'claude-opus-4-7',
      usage: {
        input_tokens: 6,
        output_tokens: 217,
        cache_read_input_tokens: 33406,
        cache_creation_input_tokens: 11581,
        cache_creation: { ephemeral_5m_input_tokens: 11581, ephemeral_1h_input_tokens: 0 }
      }
    },
    ...over
  })

describe('разбор логов Claude Code', () => {
  it('вытаскивает модель, время и все четыре вида токенов', () => {
    const rec = parseClaudeLine(claudeLine())
    expect(rec).not.toBeNull()
    expect(rec?.model).toBe('claude-opus-4-7')
    expect(rec?.ts).toBe(Date.parse('2026-07-30T15:50:39.343Z'))
    expect(rec?.usage).toEqual({
      input: 6,
      output: 217,
      cacheWrite: 11581,
      cacheWrite1h: 0,
      cacheRead: 33406
    })
  })

  it('идентификатор берётся у ОТВЕТА, а не у строки', () => {
    // На живом файле владельца один ответ лежит четырьмя строками: uuid разный, message.id
    // один. Дедуп по строке не сработал бы, и расход утроился бы.
    const a = parseClaudeLine(claudeLine({ uuid: 'aaaa' }))
    const b = parseClaudeLine(claudeLine({ uuid: 'bbbb' }))
    expect(a?.id).toBe(b?.id)
    expect(a?.id).toContain('msg_011CdYWM3a1vjpfp4JYjimJY')
  })

  it('часовой кэш учитывается отдельно от пятиминутного', () => {
    const rec = parseClaudeLine(
      claudeLine({
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 300,
            cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }
          }
        }
      })
    )
    expect(rec?.usage.cacheWrite).toBe(100)
    expect(rec?.usage.cacheWrite1h).toBe(200)
  })

  it('без разбивки кэша всё уходит в пятиминутный — ошибка в сторону занижения, а не выдумки', () => {
    const rec = parseClaudeLine(
      claudeLine({
        message: {
          id: 'msg_2',
          model: 'claude-opus-4-7',
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500 }
        }
      })
    )
    expect(rec?.usage.cacheWrite).toBe(500)
    expect(rec?.usage.cacheWrite1h).toBe(0)
  })

  it('пропускает всё, что не является ответом модели с расходом', () => {
    expect(parseClaudeLine('')).toBeNull()
    expect(parseClaudeLine('не json')).toBeNull()
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: { content: 'привет' } }))).toBeNull()
    expect(parseClaudeLine(claudeLine({ type: 'user' }))).toBeNull()
    // Синтетический ответ — локальная заглушка инструмента, денег не стоит.
    expect(
      parseClaudeLine(claudeLine({ message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 5 } } }))
    ).toBeNull()
  })

  it('отрицательные и нечисловые значения считаются нулями, а не ломают счёт', () => {
    const rec = parseClaudeLine(
      claudeLine({
        message: {
          id: 'msg_3',
          model: 'claude-opus-4-7',
          usage: { input_tokens: -5, output_tokens: 'много', cache_read_input_tokens: 10 }
        }
      })
    )
    expect(rec?.usage.input).toBe(0)
    expect(rec?.usage.output).toBe(0)
    expect(rec?.usage.cacheRead).toBe(10)
  })
})

const state = (): CodexState => ({ session: 'file', model: '', index: 0 })

describe('разбор сессий Codex', () => {
  const meta = JSON.stringify({
    type: 'session_meta',
    payload: { session_id: '019f5c38-7e75-7771-b7f0-89cfe2d52ee2' }
  })
  const turn = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })
  const tokenCount = JSON.stringify({
    timestamp: '2026-07-30T22:08:00.154Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 103371, cached_input_tokens: 76800, output_tokens: 6175, total_tokens: 109546 },
        last_token_usage: {
          input_tokens: 23801,
          cached_input_tokens: 21248,
          cache_write_input_tokens: 0,
          output_tokens: 2604,
          reasoning_output_tokens: 87
        }
      }
    }
  })

  it('кэш вычитается из входа: у Codex он УЖЕ внутри input_tokens', () => {
    const s = state()
    parseCodexLine(meta, s)
    parseCodexLine(turn, s)
    const rec = parseCodexLine(tokenCount, s)
    // 23801 = 2553 нетронутого входа + 21248 из кэша. Иначе кэш оплачивается дважды и по
    // дорогой ставке; проверяется арифметикой самого лога (total = input + output).
    expect(rec?.usage.input).toBe(2553)
    expect(rec?.usage.cacheRead).toBe(21248)
    expect(rec?.usage.output).toBe(2604)
  })

  it('модель берётся из контекста хода, объявленного раньше расхода', () => {
    const s = state()
    parseCodexLine(turn, s)
    expect(parseCodexLine(tokenCount, s)?.model).toBe('gpt-5.5')
  })

  it('накопительный total не участвует в счёте', () => {
    const s = state()
    const rec = parseCodexLine(tokenCount, s)
    // Если бы брали total_token_usage, вышло бы 103371 входа вместо 2553 — и так на каждом
    // событии сессии, то есть квадратичное завышение.
    expect(rec?.usage.input).toBeLessThan(10_000)
  })

  it('событие без last_token_usage пропускается', () => {
    const s = state()
    const summaryOnly = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5 } } }
    })
    expect(parseCodexLine(summaryOnly, s)).toBeNull()
  })

  it('идентификатор устойчив при повторном чтении того же файла', () => {
    const first = state()
    parseCodexLine(meta, first)
    const a = parseCodexLine(tokenCount, first)
    const b = parseCodexLine(tokenCount, first)
    // Внутри одного прохода номера разные — это разные события.
    expect(a?.id).not.toBe(b?.id)

    // А повторный проход по тому же файлу даёт те же идентификаторы, и дедуп их отсеет.
    const second = state()
    parseCodexLine(meta, second)
    expect(parseCodexLine(tokenCount, second)?.id).toBe(a?.id)
  })

  it('пустой расход не создаёт запись', () => {
    const s = state()
    const zero = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 0, output_tokens: 0 } } }
    })
    expect(parseCodexLine(zero, s)).toBeNull()
  })
})

describe('дата расхода', () => {
  it('берётся местная, а не UTC', () => {
    // Ночной час по местному времени легко уезжает на сутки назад при переводе в UTC — и
    // тогда «сегодняшний» расход попадает во вчерашний день.
    const ts = new Date(2026, 7, 3, 1, 30).getTime()
    expect(localDate(ts)).toBe('2026-08-03')
  })
})
