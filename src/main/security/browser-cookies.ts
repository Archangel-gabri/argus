// Куки браузера владельца — чтобы спросить квоту у самого провайдера.
//
// Зачем это здесь. Расход, посчитанный по локальным логам, — это расход ЭТОЙ машины. В те же
// аккаунты владелец ходит с телефона, со второго ноутбука и просто из браузера, поэтому локальная
// цифра всегда занижена, и насколько — неизвестно. Настоящую квоту знает только провайдер.
//
// У подписок она лежит не за API-ключом, а за сессией веб-панели: claude.ai/settings/usage и
// cursor.com/dashboard рисуются обычными запросами, которым нужна кука входа. Ключа, которым можно
// было бы спросить то же самое, у подписки не существует в принципе — Anthropic не выдаёт его
// вместе с Max, а Cursor не выдаёт вовсе.
//
// Кука никуда не копируется: читается из базы браузера в момент запроса, живёт в памяти main
// столько, сколько идёт запрос, и наружу не уходит — в renderer едет только готовая доля.
//
// Формат Chromium: `v10`/`v11` + AES-128-CBC на том же ключе Safe Storage, что и пароли. Отличие
// от паролей одно: с некоторых версий перед значением куки дописан SHA-256 её домена. Отрезать
// «первые 32 байта» вслепую нельзя — старые записи приписки не имеют, и у них так отрежется само
// значение. Поэтому приписка проверяется: она равна sha256(host_key) или её нет.

import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3-multiple-ciphers'
import { safeStorageKey } from './browser-passwords'

/** Профили, где Chromium-браузеры держат базу кук. Порядок — по вероятности. */
const COOKIE_PATHS = [
  '.config/BraveSoftware/Brave-Browser/Default/Cookies',
  '.config/google-chrome/Default/Cookies',
  '.config/chromium/Default/Cookies'
]

/**
 * Расшифровать значение куки.
 *
 * `host` нужен не для поиска, а для проверки приписки: только зная домен, можно отличить
 * SHA-256-штамп Chromium от первых байтов самого значения.
 *
 * Пустая строка означает «расшифровать не удалось» — например, ключ в KWallet сменился. Это не
 * ошибка приложения: такая кука просто пропускается.
 */
export function decryptCookie(blob: Buffer, host: string, storageKey: Buffer): string {
  const prefix = blob.subarray(0, 3).toString('ascii')
  if (prefix !== 'v10' && prefix !== 'v11') return blob.toString('utf8')
  try {
    const key = pbkdf2Sync(storageKey, Buffer.from('saltysalt', 'utf8'), 1, 16, 'sha1')
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    decipher.setAutoPadding(false)
    const raw = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()])
    const pad = raw[raw.length - 1]
    const body = pad > 0 && pad <= 16 ? raw.subarray(0, raw.length - pad) : raw

    const stamp = createHash('sha256').update(host).digest()
    const value = body.length >= 32 && body.subarray(0, 32).equals(stamp) ? body.subarray(32) : body
    return value.toString('utf8')
  } catch {
    return ''
  }
}

/** Подходит ли запись куки домену: точное совпадение или поддомен. */
export function hostMatches(hostKey: string, domain: string): boolean {
  const h = hostKey.replace(/^\./, '').toLowerCase()
  const d = domain.replace(/^\./, '').toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

/**
 * Достать куки домена по именам.
 *
 * Имена перечисляются явно, а не берутся все подряд: для запроса нужны две-три куки сессии, а
 * читать чужие счётчики и рекламные метки незачем.
 *
 * База копируется во временный файл: браузер держит её открытой, и читать оригинал нельзя.
 */
export function readCookies(domain: string, names: string[], home = homedir()): Record<string, string> {
  const source = COOKIE_PATHS.map((p) => join(home, p)).find((p) => existsSync(p))
  if (!source) return {}

  const copy = join(tmpdir(), `argus-cookies-${randomUUID()}.db`)
  try {
    copyFileSync(source, copy)
  } catch {
    return {}
  }

  try {
    const db = new Database(copy, { readonly: true })
    const rows = db.prepare('SELECT host_key, name, encrypted_value FROM cookies').all() as Array<{
      host_key: string
      name: string
      encrypted_value: Buffer
    }>
    db.close()

    const wanted = new Set(names)
    const key = safeStorageKey()
    const out: Record<string, string> = {}
    for (const r of rows) {
      if (!wanted.has(r.name) || !hostMatches(r.host_key, domain)) continue
      const value = decryptCookie(Buffer.from(r.encrypted_value), r.host_key, key).trim()
      // Одна и та же кука лежит и на домене, и на поддомене — берём первую непустую.
      if (value && !out[r.name]) out[r.name] = value
    }
    return out
  } catch {
    return {}
  } finally {
    try {
      rmSync(copy, { force: true })
    } catch {
      /* временный файл не удалился — не повод падать */
    }
  }
}

/** Собрать заголовок Cookie. Пустая строка означает «сессии в браузере нет». */
export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}
