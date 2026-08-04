// Курсы валют живут в ОДНОМ модуле — src/shared/fx.ts; конвертируют из него три места:
// vault.ts (стоимость серверов), data/subscriptions.ts (подписки и счета),
// lib/ai-account.ts (окупаемость ИИ-подписок).
//
// Раньше таблиц было три, и комментарий в каждой требовал держать их одинаковыми. Комментарий
// ничего не проверяет: таблицы разошлись — TRY на третий знак, а в третьей не было половины
// валют, и окупаемость подписки в JPY показывалась как «не знаю» при посчитанном итоге на
// соседнем экране. Этот тест сторожит две вещи:
// (1) состав общей таблицы совпадает со списком валют CURRENCY_CODES — валюта в выпадающем
//     списке без курса означала бы `?? 1`, то есть тихий пересчёт один-к-одному
//     («3790 PKR» превращаются в «$3790»);
// (2) ни одно из трёх мест не завело таблицу заново — дублирование начинается с невинного
//     «продублирую локально, чтобы не тянуть импорт», и с него же начался прошлый разъезд.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FX_TO_USD } from '../shared/fx'
import { CURRENCY_CODES } from './types'

const root = join(__dirname, '..', '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

// Все, кто конвертирует валюту. Новое конвертирующее место добавляется сюда, а не заводит
// свою таблицу.
const CONSUMERS = [
  { file: 'src/main/vault.ts', importRe: /from '\.\.\/shared\/fx'/ },
  { file: 'src/renderer/src/data/subscriptions.ts', importRe: /from '\.\.\/\.\.\/\.\.\/shared\/fx'/ },
  { file: 'src/renderer/src/lib/ai-account.ts', importRe: /from '\.\.\/\.\.\/\.\.\/shared\/fx'/ }
]

describe('таблица курсов', () => {
  it('у каждой валюты из списка есть курс', () => {
    // Иначе `?? 1` тихо считает чужую валюту долларами.
    const missing = CURRENCY_CODES.filter((c) => FX_TO_USD[c] === undefined)
    expect(missing, `валюты без курса: ${missing.join(', ')}`).toEqual([])
  })

  it('курсов больше, чем валют, не бывает', () => {
    // Курс без валюты в списке — след удалённой валюты; сам по себе безвреден, но означает,
    // что таблицу правили не там, где список.
    const extra = Object.keys(FX_TO_USD).filter((c) => !(CURRENCY_CODES as readonly string[]).includes(c))
    expect(extra, `курсы без валюты: ${extra.join(', ')}`).toEqual([])
  })

  it('все курсы положительные', () => {
    for (const [code, rate] of Object.entries(FX_TO_USD)) expect(rate, code).toBeGreaterThan(0)
  })

  it('каждое конвертирующее место берёт курсы из shared, а не заводит свои', () => {
    for (const { file, importRe } of CONSUMERS) {
      const src = read(file)
      expect(importRe.test(src), `${file}: нет импорта из src/shared/fx`).toBe(true)
      // Локальная таблица выдаёт себя литералом «КОД: число» — в этих файлах ему взяться
      // больше неоткуда (проверено на текущих исходниках: ложных срабатываний нет).
      const literal = /\b[A-Z]{3}\s*:\s*\d/.exec(src)
      expect(literal, `${file}: похоже на локальную таблицу курсов («${literal?.[0]}»)`).toBeNull()
    }
  })
})
