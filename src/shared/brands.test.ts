// Опознание компании по написанию. Ошибка здесь тихая: логотип просто не появится или появится
// чужой, и понять почему можно только сличив выражения глазами.
import { describe, expect, it } from 'vitest'
import { brandOf, initialsOf } from './brands'

describe('brandOf', () => {
  it('узнаёт компанию в обоих алфавитах', () => {
    expect(brandOf('Hetzner')).toBe('hetzner')
    expect(brandOf('Хетцнер')).toBe('hetzner')
    expect(brandOf('Spotify Premium')).toBe('spotify')
    expect(brandOf('Спотифай')).toBe('spotify')
  })

  it('узкое написание побеждает общее', () => {
    expect(brandOf('Yandex Cloud')).toBe('yandex-cloud')
    expect(brandOf('Google Cloud Platform')).toBe('google-cloud')
  })

  it('соседние продукты одной компании не получают чужой знак', () => {
    // «Яндекс Плюс» и «Яндекс Пэй» — не облако: им положен общий знак компании, а знак облака
    // на них был бы неправдой. Проверка держит ПОРЯДОК правил: общее написание стоит после
    // узкого, и если их поменять местами, облако начнёт получать корпоративный знак.
    expect(brandOf('Яндекс Плюс')).toBe('yandex')
    expect(brandOf('Yandex Pay')).toBe('yandex')
    expect(brandOf('Яндекс Облако')).toBe('yandex-cloud')
    expect(brandOf('Yandex Cloud')).toBe('yandex-cloud')
  })

  it('узнаёт компании, которых нет в simple-icons', () => {
    // Ради них и написан второй источник каталога (Wikimedia Commons): набор simple-icons
    // снимает знаки по требованию правообладателей, и этих в нём нет.
    expect(brandOf('AWS')).toBe('aws')
    expect(brandOf('Amazon Web Services')).toBe('aws')
    expect(brandOf('Oracle Cloud')).toBe('oracle')
    expect(brandOf('Ozon Premium')).toBe('ozon')
    expect(brandOf('Озон')).toBe('ozon')
    expect(brandOf('МегаФон')).toBe('megafon')
  })

  it('собирает написание из нескольких полей записи', () => {
    // У счёта учреждение и название заполняют по-разному: одно бывает пустым.
    expect(brandOf('', 'PayPal')).toBe('paypal')
    expect(brandOf('OKX', '')).toBe('okx')
    expect(brandOf(null, undefined, 'Binance')).toBe('binance')
  })

  it('ИИ-провайдеры опознаются по продукту, а не только по компании', () => {
    expect(brandOf('Claude Max 5x')).toBe('anthropic')
    expect(brandOf('ChatGPT Plus')).toBe('openai')
    expect(brandOf('Codex CLI')).toBe('openai')
  })

  it('неизвестное имя — это null, а не догадка', () => {
    // Предыдущая реализация угадывала домен из одного слова («Ромашка» → romashka.com) и
    // отправляла его в чужой сервис за логотипом. Молчание безопаснее.
    expect(brandOf('Ромашка-Хостинг')).toBeNull()
    expect(brandOf('')).toBeNull()
    expect(brandOf(null)).toBeNull()
  })
})

describe('initialsOf', () => {
  it('различает записи, отличающиеся только вторым словом', () => {
    // Ровно этот случай и заставил пропускать общее слово: обе строки живут в списке рядом.
    expect(initialsOf('VPS Германия — мастер-панель HubVPN')).toBe('ГЕ')
    expect(initialsOf('VPS Финляндия — узел HubVPN')).toBe('ФИ')
  })

  it('одиночное имя даёт две свои буквы, составное — по первой от слова', () => {
    expect(initialsOf('Boosty')).toBe('BO')
    expect(initialsOf('Spotify Premium')).toBe('SP')
    // Второе слово со строчной — не имя, и брать от него букву незачем.
    expect(initialsOf('Boosty — erafox')).toBe('BO')
  })

  it('имя из одних общих слов не остаётся пустым', () => {
    expect(initialsOf('VPS')).toBe('?')
    expect(initialsOf('')).toBe('?')
  })
})
