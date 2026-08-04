// Курсы валют лежат в ДВУХ файлах: main конвертирует стоимость серверов, renderer — подписок.
// Комментарий в обоих требует держать таблицы одинаковыми, но комментарий ничего не проверяет:
// расхождение проявится как «итог за месяц не сходится с суммой строк», и списать это будет
// не на что.
//
// Вторая ловушка тут же рядом: `FX[currency] ?? 1`. Валюта, попавшая в выпадающий список без
// курса, молча пересчитается один к одному — «3790 PKR» превратятся в «$3790». Поэтому список
// валют и таблица курсов обязаны совпадать по составу, а не только по значениям.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENCY_CODES } from './types'

const root = join(__dirname, '..', '..')

/** Вытащить карту курсов из исходника: обе объявлены литералом `КОД: число`. */
function rates(file: string, marker: string): Record<string, number> {
  const src = readFileSync(join(root, file), 'utf8')
  const start = src.indexOf(marker)
  expect(start, `в ${file} не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('}', start))
  const out: Record<string, number> = {}
  for (const m of body.matchAll(/\b([A-Z]{3})\s*:\s*([\d.]+)/g)) out[m[1]] = Number(m[2])
  return out
}

const mainFx = rates('src/main/vault.ts', 'const FX: Record<string, number> = {')
const webFx = rates('src/renderer/src/data/subscriptions.ts', 'const RATES: Record<string, number> = {')

describe('таблицы курсов', () => {
  it('в обеих одинаковый набор валют', () => {
    expect(Object.keys(mainFx).sort()).toEqual(Object.keys(webFx).sort())
  })

  it('в обеих одинаковые значения', () => {
    // Разные курсы дают разный итог у сервера и у подписки — и оба выглядят правдоподобно.
    expect(mainFx).toEqual(webFx)
  })

  it('у каждой валюты из списка есть курс', () => {
    // Иначе `?? 1` тихо считает чужую валюту долларами.
    const missing = CURRENCY_CODES.filter((c) => mainFx[c] === undefined)
    expect(missing, `валюты без курса: ${missing.join(', ')}`).toEqual([])
  })

  it('курсов больше, чем валют, не бывает', () => {
    // Курс без валюты в списке — след удалённой валюты; сам по себе безвреден, но означает,
    // что таблицу правили не там, где список.
    const extra = Object.keys(mainFx).filter((c) => !(CURRENCY_CODES as readonly string[]).includes(c))
    expect(extra, `курсы без валюты: ${extra.join(', ')}`).toEqual([])
  })

  it('все курсы положительные', () => {
    for (const [code, rate] of Object.entries(mainFx)) expect(rate, code).toBeGreaterThan(0)
  })
})
