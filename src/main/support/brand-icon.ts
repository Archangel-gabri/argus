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
import { decodePng, encodePng, monochrome } from '../../shared/png-mono.mjs'


/**
 * Адрес, по которому не жалко сходить.
 *
 * Здесь единственное место приложения, где адрес запроса диктует ЧУЖАЯ страница: значок
 * указан в её разметке и лежит, как правило, на стороннем CDN (`cdn.tbank.ru`,
 * `paypalobjects.com`), поэтому запретить чужие домены нельзя — на них всё и лежит.
 *
 * Зато можно запретить то, что снаружи не бывает. Без этой проверки страница банка — своя или
 * подменённая — могла назвать значком `http://127.0.0.1:4822/x.png`, и приложение постучалось бы
 * в guacd на петле; `169.254.169.254` в облаке отдаёт учётные данные машины, а `file:///x.png`
 * прочитал бы диск. Ни один настоящий значок так не адресуется.
 */
export function publicHttpsUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // Только https: обычный http дал бы подменить картинку любому, кто сидит на канале, а прочие
  // схемы (file:, data:, blob:) к сети отношения не имеют вовсе.
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // Служебные имена локальной сети. Точки в них есть, поэтому проверкой на «домен» не ловятся.
  if (host === 'localhost' || /\.(local|internal|lan|home|localdomain)$/.test(host)) return null

  // IPv4-литерал: петля, частные сети и link-local (там же облачные метаданные).
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0 || a === 169 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return null
    }
  }
  // IPv6: петля, уникальные локальные (fc00::/7) и link-local (fe80::/10).
  if (host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return null

  return url.href
}

/**
 * Достать PNG из файла `.ico`.
 *
 * У половины сайтов значок объявлен только как `favicon.ico`, и пропускать их значит остаться
 * без знака там, где он есть. Разбирать сам формат не нужно: начиная с Vista кадр внутри ICO
 * хранят готовым PNG — берём самый крупный такой кадр. Если внутри старый BMP, отступаем:
 * распаковывать его ради значка не стоит, буквы названия честнее наполовину собранной картинки.
 */
export function pngInsideIco(buf: Buffer): Buffer | null {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x00010000) return null
  const count = buf.readUInt16LE(4)
  let best: { size: number; data: Buffer } | null = null
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    if (entry + 16 > buf.length) break
    const width = buf[entry] || 256
    const bytes = buf.readUInt32LE(entry + 8)
    const offset = buf.readUInt32LE(entry + 12)
    if (offset + bytes > buf.length) continue
    const frame = buf.subarray(offset, offset + bytes)
    if (frame.length < 8 || frame.readUInt32BE(0) !== 0x89504e47) continue
    if (!best || width > best.size) best = { size: width, data: frame }
  }
  return best?.data ?? null
}

/** Заголовок обычного браузера — иначе часть сайтов отвечает отказом или урезанной страницей. */
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** Куда смотрим, если сайт не сказал сам. Порядок — от крупного к мелкому: 180×180 лучше 16×16. */
const GUESSES = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/favicon-192.png',
  '/favicon.png',
  '/favicon.ico'
]

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
    if (!/\.(png|ico)(\?|$)/i.test(href)) continue
    const size = Number(/sizes=["']?(\d+)/i.exec(tag)?.[1] ?? 0)
    let abs: string
    try {
      abs = new URL(href, pageUrl).href
    } catch {
      continue
    }
    const safe = publicHttpsUrl(abs)
    if (safe) found.push({ href: safe, size })
  }
  return found.sort((a, b) => b.size - a.size).map((f) => f.href)
}

/** Домен в том виде, в каком его можно поставить в адрес. Мусор отсекаем здесь, а не в сети. */
export function cleanDomain(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
  // Требуем точку и допустимые символы: «сбер» доменом не является, а идти в сеть за ним —
  // это ждать таймаут ради заведомо пустого ответа.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw)) return null
  // Форма домена ещё ничего не гарантирует: `127.0.0.1`, `10.0.0.5` и `router.lan` выглядят
  // доменами и проходят её насквозь. Настоящий фильтр — тот же, что для адресов со страницы.
  return publicHttpsUrl(`https://${raw}/`) ? raw : null
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
      // Редиректы разбираем сами: без этого сайт отдаёт 302 на `http://127.0.0.1:4822` и все
      // проверки адреса оказываются бесполезны — запрос всё равно уходит на петлю.
      const req = net.request({ method: 'GET', url, redirect: 'manual' })
      // Обычный браузерный заголовок: часть сайтов отдаёт разметку только «настоящему»
      // посетителю, а нам нужна ровно та же страница, что видит человек.
      req.setHeader('user-agent', BROWSER_UA)
      req.setHeader('accept', '*/*')
      let hops = 0
      req.on('redirect', (_status, _method, redirectUrl) => {
        if (hops++ >= 3 || !publicHttpsUrl(redirectUrl)) {
          req.abort()
          clearTimeout(timer)
          finish(null)
          return
        }
        req.followRedirect()
      })
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
  //
  // Форм адреса две: голый домен и `www`. Половина сайтов живёт на второй и с первой отвечает
  // редиректом — и хотя редиректы мы разбираем, проверка показала, что до разметки так доходят
  // не все (Сбер и Kraken отдавали ссылки на значок только по `www`). Лишний запрос дешевле
  // молчаливо пустого результата.
  let page: Buffer | null = null
  let pageUrl = `https://${domain}/`
  // Дошёл ли хоть один ответ. Отличает «у сайта нет значка» от «у нас нет интернета».
  let reached = false
  for (const candidate of [`https://${domain}/`, `https://www.${domain}/`]) {
    page = await download(candidate, 12000)
    if (page) reached = true
    if (page && /<link/i.test(page.toString('utf8').slice(0, 200_000))) {
      pageUrl = candidate
      break
    }
  }
  const candidates = [
    ...(page ? iconLinksFrom(page.toString('utf8').slice(0, 200_000), pageUrl) : []),
    ...GUESSES.map((g) => `https://${domain}${g}`)
  ]

  for (const url of candidates.slice(0, 6)) {
    const raw = await download(url)
    if (raw) reached = true
    if (!raw || raw.length < 100) continue
    try {
      // Сайт отдаёт либо PNG, либо ICO — во втором случае внутри чаще всего лежит тот же PNG.
      const source = raw.readUInt32BE(0) === 0x89504e47 ? raw : pngInsideIco(raw)
      if (!source) continue
      const img = decodePng(source)
      const mono = monochrome(img)
      // Пустой или сплошной силуэт значит, что фон определился неверно. Класть такое в список
      // нельзя: серый квадрат на месте логотипа хуже букв, потому что выглядит как знак.
      const share = mono.ink / (mono.width * mono.height)
      if (share < 0.01 || share > 0.95) continue
      const png = encodePng(mono)
      writeFileSync(file, png)
      return { ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
    } catch {
      // Формат не тот (бывает SVG или BMP внутри ICO) — пробуем следующий адрес.
      continue
    }
  }

  // Отметку «значка нет» ставим ТОЛЬКО если сайт ответил и значка у него правда не нашлось.
  // Если ни один запрос не дошёл — это отсутствие сети, а не отсутствие значка; записав отметку,
  // мы запомнили бы «у Сбербанка нет логотипа» навсегда, и после возвращения интернета знак уже
  // не появился бы никогда.
  if (reached) writeFileSync(missPath(domain), '')
  return { ok: false, error: reached ? 'значок не найден' : 'нет связи — попробуем позже' }
}
