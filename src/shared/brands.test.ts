// Опознание компании по написанию. Ошибка здесь тихая: логотип просто не появится или появится
// чужой, и понять почему можно только сличив выражения глазами.
import { describe, expect, it } from 'vitest'
import { brandOf } from './brands'

describe('brandOf', () => {
  it('узнаёт компанию в обоих алфавитах', () => {
    expect(brandOf('Hetzner')).toBe('hetzner')
    expect(brandOf('Хетцнер')).toBe('hetzner')
    expect(brandOf('Spotify Premium')).toBe('spotify')
    expect(brandOf('Спотифай')).toBe('spotify')
  })

  it('узкое написание побеждает общее', () => {
    // Порядок правил — не косметика: «Yandex Cloud» не должен опознаваться как просто «Yandex»,
    // а «Google Cloud» — как «Google» (которого в каталоге и нет).
    expect(brandOf('Yandex Cloud')).toBe('yandex-cloud')
    expect(brandOf('Google Cloud Platform')).toBe('google-cloud')
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
