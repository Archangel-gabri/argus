// Импорт паролей из браузера трогает чужие секреты — ошибка здесь либо тихо отдаёт мусор
// вместо пароля, либо цепляет запись не того сайта.
import { describe, expect, it } from 'vitest'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { decryptValue, matchesProvider } from './browser-passwords'
import { classifyLogin, FAMILY_DOMAINS, providerFamily } from '../shared/ai-providers'

/** Зашифровать так, как это делает Chromium на Linux: v10 + AES-128-CBC на ключе из «Safe Storage». */
function encryptLikeChromium(value: string, storageKey: string): Buffer {
  const key = pbkdf2Sync(Buffer.from(storageKey, 'utf8'), Buffer.from('saltysalt', 'utf8'), 1, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10', 'ascii'), cipher.update(Buffer.from(value, 'utf8')), cipher.final()])
}

describe('расшифровка сохранённого пароля', () => {
  it('возвращает исходное значение', () => {
    const blob = encryptLikeChromium('пароль-из-браузера', 'peanuts')
    expect(decryptValue(blob, Buffer.from('peanuts', 'utf8'))).toBe('пароль-из-браузера')
  })

  it('снимает дополнение, не оставляя хвоста', () => {
    // Длина 16 байт даёт целый блок дополнения — на нём и ломаются наивные реализации.
    const value = '0123456789abcdef'
    const blob = encryptLikeChromium(value, 'peanuts')
    expect(decryptValue(blob, Buffer.from('peanuts', 'utf8'))).toBe(value)
  })

  it('чужой ключ не притворяется успехом', () => {
    // Расшифровка неверным ключом даёт мусор; записать такой «пароль» в вольт хуже, чем
    // пропустить запись.
    const blob = encryptLikeChromium('секрет', 'peanuts')
    const wrong = decryptValue(blob, Buffer.from('другой-ключ', 'utf8'))
    expect(wrong).not.toBe('секрет')
  })

  it('незашифрованное значение отдаётся как есть', () => {
    expect(decryptValue(Buffer.from('простой-текст', 'utf8'), Buffer.from('peanuts', 'utf8'))).toBe('простой-текст')
  })
})

describe('сопоставление записи с провайдером', () => {
  it('узнаёт домен и его поддомены', () => {
    expect(matchesProvider('https://chatgpt.com/', 'openai')).toBe(true)
    expect(matchesProvider('https://auth.openai.com/log-in', 'openai')).toBe(true)
    expect(matchesProvider('https://claude.ai/login', 'anthropic')).toBe(true)
  })

  it('похожий домен НЕ считается своим', () => {
    // «notopenai.com» заканчивается на «openai.com» — сравнение по подстроке отдало бы чужой пароль.
    expect(matchesProvider('https://notopenai.com/', 'openai')).toBe(false)
    expect(matchesProvider('https://openai.com.evil.ru/', 'openai')).toBe(false)
  })

  it('незнакомый провайдер не цепляет ничего', () => {
    expect(matchesProvider('https://chatgpt.com/', 'нет-такого')).toBe(false)
  })

  it('свой адрес доступа расширяет поиск', () => {
    // У роутеров и своих серверов домен известен только из записи.
    expect(matchesProvider('https://cli.neutrino.su/', 'openai', ['cli.neutrino.su'])).toBe(true)
  })

  it('у каждой известной семьи есть хотя бы один домен', () => {
    for (const [family, domains] of Object.entries(FAMILY_DOMAINS)) {
      expect(domains.length, family).toBeGreaterThan(0)
    }
  })

  it('Codex и ChatGPT — один провайдер, значит и аккаунты общие', () => {
    // Роутер меняет только маршрут запроса; почты, которыми владелец входит, те же.
    expect(providerFamily('codex')).toBe('openai')
    expect(providerFamily('chatgpt')).toBe('openai')
    expect(matchesProvider('https://chatgpt.com/', 'codex')).toBe(true)
  })

  it('вход через Google отмечается отдельно от прямого пароля', () => {
    // Пароль от accounts.google.com — не пароль от OpenAI; смешивать их нельзя, но и терять
    // тоже: в большинство сервисов владелец входит именно так.
    expect(classifyLogin('https://chatgpt.com/', 'openai')).toEqual({ kind: 'direct' })
    expect(classifyLogin('https://accounts.google.com/', 'openai')).toEqual({ kind: 'identity', via: 'Google' })
    // У DeepSeek входа через Apple нет — запись Apple ID к нему не относится.
    expect(classifyLogin('https://appleid.apple.com/', 'deepseek')).toBeNull()
  })
})
