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
}

/**
 * Домены, по которым узнаётся провайдер.
 *
 * Сопоставление по домену, а не по названию записи: у одного провайдера сайт входа и сайт
 * консоли — разные адреса, а название владелец мог поменять как угодно.
 */
export const PROVIDER_DOMAINS: Record<string, string[]> = {
  openai: ['openai.com', 'chatgpt.com'],
  anthropic: ['claude.ai', 'anthropic.com'],
  gemini: ['google.com', 'aistudio.google.com'],
  deepseek: ['deepseek.com'],
  openrouter: ['openrouter.ai'],
  github: ['github.com'],
  cursor: ['cursor.sh', 'cursor.com'],
  mistral: ['mistral.ai'],
  groq: ['groq.com'],
  cerebras: ['cerebras.ai'],
  perplexity: ['perplexity.ai'],
  modelscope: ['modelscope.cn'],
  nvidia_nim: ['nvidia.com'],
  tavily: ['tavily.com'],
  exa: ['exa.ai'],
  firecrawl: ['firecrawl.dev'],
  huggingface: ['huggingface.co'],
  xai: ['x.ai', 'grok.com']
}

/** Подходит ли сохранённая запись этому провайдеру. */
export function matchesProvider(originUrl: string, provider: string, extraDomains: string[] = []): boolean {
  const domains = [...(PROVIDER_DOMAINS[provider.toLowerCase()] ?? []), ...extraDomains]
  if (!domains.length) return false
  const host = originUrl.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
  // Именно суффикс с точкой: иначе «notopenai.com» сойдёт за openai.com.
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

function safeStorageKey(): Buffer {
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
    const rows = db.prepare('SELECT origin_url, username_value, password_value FROM logins').all() as Array<{
      origin_url: string
      username_value: string
      password_value: Buffer
    }>
    db.close()

    const key = safeStorageKey()
    const out: BrowserLogin[] = []
    for (const r of rows) {
      if (!r.username_value || !matchesProvider(r.origin_url, provider, extraDomains)) continue
      const password = decryptValue(Buffer.from(r.password_value), key)
      if (!password) continue
      out.push({ origin: r.origin_url, username: r.username_value, password })
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
