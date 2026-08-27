// Формат кук Chromium подставляет ровно одну подножку: перед значением может стоять SHA-256
// домена, а может не стоять — зависит от версии, которой куку записали. Отрезать 32 байта вслепую
// значит испортить каждую старую запись; не отрезать вовсе — испортить каждую новую.
import { describe, expect, it } from 'vitest'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { cookieHeader, decryptCookie, hostMatches } from './browser-cookies'

const KEY = Buffer.from('storage-key', 'utf8')

/** Собрать куку так, как её пишет сам Chromium: v10 + AES-128-CBC + PKCS#7. */
function encrypt(value: string, host: string | null): Buffer {
  const key = pbkdf2Sync(KEY, Buffer.from('saltysalt', 'utf8'), 1, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  const stamp = host ? createHash('sha256').update(host).digest() : Buffer.alloc(0)
  const body = Buffer.concat([stamp, Buffer.from(value, 'utf8')])
  return Buffer.concat([Buffer.from('v10', 'ascii'), cipher.update(body), cipher.final()])
}

describe('расшифровка куки', () => {
  it('снимает штамп домена, когда он есть', () => {
    const blob = encrypt('sess-abc', '.claude.ai')
    expect(decryptCookie(blob, '.claude.ai', KEY)).toBe('sess-abc')
  })

  it('не трогает значение, когда штампа нет', () => {
    // Куки, записанные старой версией браузера, идут без приписки. Отрезав у них 32 байта, мы
    // получили бы обрубок сессии — и запрос ушёл бы с ним, отвечая непонятной ошибкой.
    const blob = encrypt('короткое-значение-без-штампа-32+', null)
    expect(decryptCookie(blob, '.claude.ai', KEY)).toBe('короткое-значение-без-штампа-32+')
  })

  it('штамп чужого домена не снимается', () => {
    // Совпадение первых 32 байт со штампом ДРУГОГО домена — не повод резать: значит, это данные.
    const blob = encrypt('x', '.cursor.com')
    expect(decryptCookie(blob, '.claude.ai', KEY)).not.toBe('x')
  })

  it('чужой ключ даёт пустоту, а не мусор', () => {
    const blob = encrypt('sess', '.claude.ai')
    const wrong = decryptCookie(blob, '.claude.ai', Buffer.from('другой-ключ', 'utf8'))
    expect(wrong === '' || wrong !== 'sess').toBe(true)
  })

  it('незашифрованное значение отдаётся как есть', () => {
    expect(decryptCookie(Buffer.from('plain', 'utf8'), 'x', KEY)).toBe('plain')
  })
})

describe('совпадение домена', () => {
  it('домен и его поддомены — да, чужой хвост — нет', () => {
    expect(hostMatches('.claude.ai', 'claude.ai')).toBe(true)
    expect(hostMatches('claude.ai', 'claude.ai')).toBe(true)
    expect(hostMatches('api.claude.ai', 'claude.ai')).toBe(true)
    // Иначе кука сайта «не-claude.ai» уехала бы в запрос к claude.ai.
    expect(hostMatches('notclaude.ai', 'claude.ai')).toBe(false)
    expect(hostMatches('claude.ai.evil.com', 'claude.ai')).toBe(false)
  })
})

describe('заголовок Cookie', () => {
  it('собирается парами через точку с запятой', () => {
    expect(cookieHeader({ a: '1', b: '2' })).toBe('a=1; b=2')
    expect(cookieHeader({})).toBe('')
  })
})
