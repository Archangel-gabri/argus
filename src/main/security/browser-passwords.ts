// Чтение паролей, сохранённых в браузере владельца (Brave/Chromium на Linux).
//
// Зачем это здесь. Учётные записи AI-провайдеров у владельца уже лежат в браузере — заводить их
// в Argus заново значит переписывать десяток паролей руками, и половина окажется неверной.
// Импорт делает реестр по-настоящему рабочим: у каждого аккаунта появляется пароль, которым
// можно войти, не открывая менеджер браузера.
//
// Как устроено шифрование Chromium на Linux: значение в базе — это `v10`/`v11` + AES-128-CBC,
// ключ выведен PBKDF2-SHA1 из «Safe Storage»-строки (у Brave она лежит в KWallet или в
// gnome-keyring; если хранилища нет, Chromium шифрует на строке `peanuts`). Соль, число
// итераций и вектор инициализации у него фиксированные — это не наша выдумка, а его формат.
//
// Значения паролей НИКОГДА не покидают main-процесс: наружу уходит только счётчик и признак
// «пароль есть».

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv, pbkdf2Sync, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3-multiple-ciphers'
import { classifyLogin, providerFamily, type LoginKind } from '../../shared/ai-providers'

/** Профили, где Chromium-браузеры держат базу паролей. Порядок — по вероятности. */
const PROFILE_PATHS = [
  '.config/BraveSoftware/Brave-Browser/Default/Login Data',
  '.config/google-chrome/Default/Login Data',
  '.config/chromium/Default/Login Data'
]

/** Пары «папка KWallet → запись» для разных сборок. */
const KWALLET_ENTRIES: Array<[string, string]> = [
  ['Brave Keys', 'Brave Safe Storage'],
  ['Chrome Keys', 'Chrome Safe Storage'],
  ['Chromium Keys', 'Chromium Safe Storage']
]

export interface BrowserLogin {
  origin: string
  username: string
  password: string
  /** Прямой пароль сервиса или вход через чужой аккаунт. */
  kind: LoginKind
  /** Через кого входим, если вход не прямой: Google, GitHub, Apple. */
  via?: string
  /** Сколько раз браузер подставлял этот пароль. Ноль — аккаунт заведён, но им не пользовались. */
  timesUsed: number
  /** Когда подставлял в последний раз (мс). null — никогда. */
  lastUsedAt: number | null
}

/**
 * Время Chromium — микросекунды с 1601 года.
 *
 * Ноль означает «никогда», а не 1601-й: без этой проверки все неиспользованные записи получают
 * дату из семнадцатого века и выглядят как древние, но настоящие.
 */
export function chromeTimeToMs(value: number): number | null {
  if (!value || value <= 0) return null
  const ms = value / 1000 - 11_644_473_600_000
  return ms > 0 ? Math.round(ms) : null
}

/** Подходит ли сохранённая запись провайдеру: прямой пароль сервиса или вход через Google. */
export function matchesProvider(originUrl: string, provider: string, extraDomains: string[] = []): boolean {
  return classifyLogin(originUrl, providerFamily(provider), extraDomains) !== null
}

/** Ключ Safe Storage браузера. Экспортирован: на нём же зашифрованы куки (`browser-cookies.ts`). */
export function safeStorageKey(): Buffer {
  for (const [folder, entry] of KWALLET_ENTRIES) {
    try {
      const out = execFileSync('kwallet-query', ['-f', folder, '-r', entry, 'kdewallet'], {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (out && !/not found|failed/i.test(out)) return Buffer.from(out, 'utf8')
    } catch {
      /* этой записи нет — пробуем следующую */
    }
  }
  // Профиль без хранилища ключей Chromium шифрует на этой строке — так задумано им самим.
  return Buffer.from('peanuts', 'utf8')
}

/**
 * Расшифровать значение из базы паролей.
 *
 * Пустая строка означает «расшифровать не удалось» — например, ключ в KWallet сменился. Это не
 * ошибка приложения: такие записи просто пропускаются, а не рушат импорт.
 */
export function decryptValue(blob: Buffer, storageKey: Buffer): string {
  const prefix = blob.subarray(0, 3).toString('ascii')
  if (prefix !== 'v10' && prefix !== 'v11') return blob.toString('utf8')
  try {
    const key = pbkdf2Sync(storageKey, Buffer.from('saltysalt', 'utf8'), 1, 16, 'sha1')
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    decipher.setAutoPadding(false)
    const raw = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()])
    // Дополнение PKCS#7 снимаем сами: длина в последнем байте.
    const pad = raw[raw.length - 1]
    const body = pad > 0 && pad <= 16 ? raw.subarray(0, raw.length - pad) : raw
    return body.toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Достать сохранённые логины для провайдера.
 *
 * База копируется во временный файл: браузер держит её открытой, и читать оригинал нельзя.
 */
export function readLogins(provider: string, extraDomains: string[] = [], home = homedir()): BrowserLogin[] {
  const source = PROFILE_PATHS.map((p) => join(home, p)).find((p) => existsSync(p))
  if (!source) return []

  const copy = join(tmpdir(), `argus-logins-${randomUUID()}.db`)
  try {
    copyFileSync(source, copy)
  } catch {
    return []
  }

  try {
    // База браузера обычная, без шифрования файла: тот же драйвер, что и у вольта, читает её
    // как есть — отдельная зависимость ради этого не нужна.
    const db = new Database(copy, { readonly: true })
    const rows = db
      .prepare('SELECT origin_url, username_value, password_value, times_used, date_last_used FROM logins')
      .all() as Array<{
      origin_url: string
      username_value: string
      password_value: Buffer
      times_used: number | null
      date_last_used: number | null
    }>
    db.close()

    const key = safeStorageKey()
    const family = providerFamily(provider)
    const out: BrowserLogin[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      if (!r.username_value) continue
      const match = classifyLogin(r.origin_url, family, extraDomains)
      if (!match) continue
      // Один и тот же аккаунт лежит в браузере несколько раз (разные поддомены входа).
      const dedupe = `${match.kind}:${r.username_value.trim().toLowerCase()}`
      if (seen.has(dedupe)) continue
      const password = decryptValue(Buffer.from(r.password_value), key)
      if (!password) continue
      seen.add(dedupe)
      out.push({
        origin: r.origin_url,
        username: r.username_value,
        password,
        kind: match.kind,
        via: match.via,
        timesUsed: r.times_used ?? 0,
        lastUsedAt: chromeTimeToMs(r.date_last_used ?? 0)
      })
    }
    return out
  } catch {
    return []
  } finally {
    try {
      rmSync(copy, { force: true })
    } catch {
      /* временный файл не удалился — не повод падать */
    }
  }
}
