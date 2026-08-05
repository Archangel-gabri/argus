// Значок компании по её домену.
//
// Владелец попросил подтягивать настоящие ярлыки — «Bybit» буквами BY выглядит бедно. Раньше
// такое решали сервисами «логотип по домену» (Clearbit и наследники): им отправляют домен, они
// отдают картинку. Так делать нельзя и не будем — это значит сообщить чужой компании список
// всех банков, бирж и хостеров владельца, то есть его финансовую топологию, ради картинки.
// К тому же Clearbit отключён, и все обёртки поверх него мертвы.
//
// Берём значок У САМОЙ КОМПАНИИ: `https://<домен>/apple-touch-icon.png` и далее по списку.
// Запрос уходит ровно тому, чей это счёт, — то есть тому, к кому владелец и так ходит в кабинет.
// Никакая третья сторона о наборе счетов не узнаёт.
//
// Дальше значок приводится к одной краске тем же способом, что и логотипы в поставке
// (`tools/monochrome-logo.mjs`): фон определяется по углам, вычитается, остаётся серый силуэт.
// Цветной ярлык в тёмном списке читался бы как состояние, а цвет в приложении занят делом.
//
// Скачанное лежит в userData и переиспользуется: сеть нужна ОДИН раз на домен. Нет интернета —
// нет значка, и это нормальный исход, а не ошибка: строка останется с буквами.

import { app, net } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng, encodePng, monochrome } from '../shared/png-mono.mjs'

/** Куда смотрим, если сайт не сказал сам. Порядок — от крупного к мелкому: 180×180 лучше 16×16. */
const GUESSES = ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon-192.png', '/favicon.png']

/**
 * Где значок лежит на самом деле — спрашиваем у страницы.
 *
 * Угадывание путей почти не работает: проверено на восьми сайтах банков и бирж, ответил один
 * из восьми. Зато `<link rel="…icon">` в разметке есть почти у всех, и там же указан размер —
 * по нему и выбираем самый крупный. Ссылки бывают относительными и с другого домена (CDN),
 * поэтому приводим к абсолютным через адрес самой страницы.
 */
export function iconLinksFrom(html: string, pageUrl: string): string[] {
  const found: Array<{ href: string; size: number }> = []
  for (const m of html.matchAll(/<link\s[^>]*>/gi)) {
    const tag = m[0]
    if (!/rel=["']?[^"'>]*icon/i.test(tag)) continue
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1]
    if (!href) continue
    // PNG предпочтителен: SVG нечем растеризовать, ICO — свой формат, до него дело не дошло.
    if (!/\.png(\?|$)/i.test(href)) continue
    const size = Number(/sizes=["']?(\d+)/i.exec(tag)?.[1] ?? 0)
    try {
      found.push({ href: new URL(href, pageUrl).href, size })
    } catch {
      /* негодная ссылка — пропускаем */
    }
  }
  return found.sort((a, b) => b.size - a.size).map((f) => f.href)
}

/** Домен в том виде, в каком его можно поставить в адрес. Мусор отсекаем здесь, а не в сети. */
export function cleanDomain(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
  // Требуем точку и допустимые символы: «сбер» доменом не является, а идти в сеть за ним —
  // это ждать таймаут ради заведомо пустого ответа.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) return null
  return raw
}

const cacheDir = (): string => {
  const dir = join(app.getPath('userData'), 'brand-icons')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Пустой файл-отметка: домен уже проверяли и значка там нет. Иначе ходим в сеть каждый раз. */
const missPath = (domain: string): string => join(cacheDir(), `${domain}.miss`)
const iconPath = (domain: string): string => join(cacheDir(), `${domain}.png`)

function download(url: string, timeoutMs = 6000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: Buffer | null): void => {
      if (done) return
      done = true
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      const req = net.request({ method: 'GET', url })
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer)
          finish(null)
          return
        }
        const parts: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          // Мегабайта на значок хватает с запасом; больше — это не значок, а чья-то ошибка.
          if (size > 1_000_000) {
            clearTimeout(timer)
            finish(null)
            return
          }
          parts.push(c)
        })
        res.on('end', () => {
          clearTimeout(timer)
          finish(Buffer.concat(parts))
        })
        res.on('error', () => {
          clearTimeout(timer)
          finish(null)
        })
      })
      req.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
      req.end()
    } catch {
      clearTimeout(timer)
      finish(null)
    }
  })
}

export interface BrandIcon {
  ok: boolean
  /** PNG в виде data-URL — renderer вставляет его прямо в `img`, файловых путей туда не даём. */
  dataUrl?: string
  error?: string
}

/**
 * Найти значок для домена: сначала на диске, потом у самой компании.
 *
 * `refetch` заставляет сходить в сеть заново — на случай, если компания сменила знак.
 */
export async function brandIcon(input: string, refetch = false): Promise<BrandIcon> {
  const domain = cleanDomain(input)
  if (!domain) return { ok: false, error: 'это не похоже на домен' }

  const file = iconPath(domain)
  if (!refetch && existsSync(file)) {
    return { ok: true, dataUrl: `data:image/png;base64,${readFileSync(file).toString('base64')}` }
  }
  if (!refetch && existsSync(missPath(domain))) return { ok: false, error: 'у сайта нет значка' }

  // Сначала спрашиваем страницу, потом гадаем. Второе почти никогда не срабатывает, но стоит
  // одного запроса и выручает сайты, которые отдают разметку не сразу.
  const page = await download(`https://${domain}/`, 9000)
  const candidates = [
    ...(page ? iconLinksFrom(page.toString('utf8').slice(0, 200_000), `https://${domain}/`) : []),
    ...GUESSES.map((g) => `https://${domain}${g}`)
  ]

  for (const url of candidates.slice(0, 6)) {
    const raw = await download(url)
    if (!raw || raw.length < 100) continue
    try {
      const img = decodePng(raw)
      const mono = monochrome(img)
      // Пустой или сплошной силуэт значит, что фон определился неверно. Класть такое в список
      // нельзя: серый квадрат на месте логотипа хуже букв, потому что выглядит как знак.
      const share = mono.ink / (mono.width * mono.height)
      if (share < 0.01 || share > 0.95) continue
      const png = encodePng(mono)
      writeFileSync(file, png)
      return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
    } catch {
      // Не PNG (часто отдают ICO под именем .png) — пробуем следующий адрес.
      continue
    }
  }

  writeFileSync(missPath(domain), '')
  return { ok: false, error: 'значок не найден' }
}
