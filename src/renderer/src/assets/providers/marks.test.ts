// Каталог знаков собирается скриптом из чужих SVG (tools/build-brand-catalog.mjs), то есть в
// исходники приложения попадает разметка, которую никто не читал глазами. Проверки ниже — про
// форму этой разметки: знак должен рисоваться ОДНИМ цветом в КВАДРАТНОЙ ячейке, и всё, что в
// эту форму не влезает, на экране превращается не в «чуть хуже», а в пятно или полоску.
//
// Ошибка здесь тихая вдвойне: сборка проходит, типы сходятся, и увидеть её можно только открыв
// нужный раздел и присмотревшись к значку размером 16 пикселей.
import { describe, expect, it } from 'vitest'
import { BRAND_MARKS } from '../brands/catalog'
import { PROVIDER_MARKS, markFor } from './marks'

describe('каталог знаков', () => {
  const brands = Object.entries(BRAND_MARKS)

  it('не пустой', () => {
    expect(brands.length).toBeGreaterThan(30)
  })

  it.each(brands)('%s — знак пригоден для квадратной ячейки', (_key, mark) => {
    const box = mark.vb.trim().split(/[\s,]+/).map(Number)
    expect(box).toHaveLength(4)
    const [, , w, h] = box
    expect(w).toBeGreaterThan(0)
    expect(h).toBeGreaterThan(0)
    // Знак рисуется в квадрате 16–32 px. Логотип-надпись пропорций 6:1 сжимается в такой ячейке
    // до полоски высотой три пикселя — она не читается и ломает ряд сильнее, чем её отсутствие.
    expect(w / h).toBeLessThanOrEqual(3)
    expect(h / w).toBeLessThanOrEqual(3)
    expect(mark.paths.length).toBeGreaterThan(0)
    // Много контуров у одноцветного знака означает надпись, разобранную на буквы.
    expect(mark.paths.length).toBeLessThanOrEqual(3)
  })

  it.each(brands)('%s — цвет не вшит в контуры', (_key, mark) => {
    // Знак наследует цвет текста. Вшитая заливка это отменяет — и один значок в списке начинает
    // светиться фирменным цветом, пока остальные серые.
    for (const path of mark.paths) expect(path.fill).toBeUndefined()
  })

  it.each(brands)('%s — записана лицензия исходного файла', (_key, mark) => {
    // Источников уже два, часть файлов требует указания авторства. Ответ на вопрос «откуда этот
    // контур и на каких условиях» должен лежать рядом с контуром, иначе он теряется при первой
    // же пересборке каталога.
    expect(mark.license).toBeTruthy()
  })
})

describe('markFor', () => {
  it('находит знак по свободному написанию, а не только по ключу', () => {
    expect(markFor('Хетцнер')).toBe(BRAND_MARKS.hetzner)
    expect(markFor('Claude Max 5x')).toBe(PROVIDER_MARKS.anthropic)
  })

  it('находит компании, добавленные из Wikimedia Commons', () => {
    expect(markFor('AWS')).toBe(BRAND_MARKS.aws)
    expect(markFor('Oracle Cloud')).toBe(BRAND_MARKS.oracle)
    expect(markFor('Ozon Premium')).toBe(BRAND_MARKS.ozon)
    expect(markFor('МегаФон')).toBe(BRAND_MARKS.megafon)
  })

  it('не путает облако Яндекса с самим Яндексом', () => {
    expect(markFor('Яндекс Облако')).toBe(BRAND_MARKS['yandex-cloud'])
    expect(markFor('Яндекс Плюс')).toBe(BRAND_MARKS.yandex)
  })

  it('неизвестная компания — это null, а не чужой знак', () => {
    expect(markFor('Ромашка-Хостинг')).toBeNull()
  })
})
