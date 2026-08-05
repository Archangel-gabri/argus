#!/usr/bin/env node
// Сборка вшитого каталога логотипов компаний.
//
// Зачем вшивать, а не тянуть по домену на лету. Готовые сервисы «логотип по домену» существуют
// (logo.dev, Brandfetch, Logokit), но платят за них не деньгами: каждый такой запрос сообщает
// чужой компании, каким хостером, банком и биржей пользуется владелец, — то есть весь его
// портфель разом. Ради того, чтобы не отправить наружу лишний IP, в приложении написан целый
// модуль ip-privacy; отдавать тот же список добровольно было бы странно. Плюс Clearbit, на
// котором держались все подобные решения, отключён в декабре 2025 — проверено, домен больше не
// резолвится, и приложение, зависящее от такого сервиса, однажды просто перестаёт рисовать знаки.
//
// Здесь логотипы берутся из свободных источников и вшиваются в исходники РАЗОБРАННЫМИ на
// контуры — тем же форматом, что уже принят для знаков ИИ-провайдеров (assets/providers/marks.ts).
// Так знак рисуется обычными React-элементами, работает без сети и не заводит в приложении места,
// куда однажды подставят чужую строку.
//
// Источников два, и второй появился по нужде:
//   1) simple-icons (CC0) — закрывает мировые сервисы;
//   2) Wikimedia Commons через Wikidata — закрывает то, чего в simple-icons нет и не будет:
//      набор снимает знаки по требованию правообладателей, поэтому там отсутствуют Сбер, Т-Банк,
//      Ozon, Wildberries, МТС, МегаФон, Билайн, Яндекс, Oracle, AWS, Bybit, Kraken, ЮMoney
//      (проверено запросом к cdn.simpleicons.org — все отвечают 404).
//
// Знак рисуется цветом текста, поэтому из чужого файла берутся ТОЛЬКО контуры. Из этого следует
// главное правило разбора: файл, который в монохроме превращается в пятно (градиенты, наложение
// разноцветных фигур, обводки), не берётся вовсе. Лучше монограмма из двух букв, чем клякса.
//
// Запуск: npm run brand:logos

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'src', 'renderer', 'src', 'assets', 'brands', 'catalog.ts')

// Ключ каталога → slug в simple-icons. Ключи — это то, что приложение выводит из своих данных
// (хостер устройства, учреждение счёта, провайдер подписки), см. src/shared/brands.ts.
const SIMPLE_ICONS = {
  // Хостеры и облака
  hetzner: 'hetzner',
  ovh: 'ovh',
  digitalocean: 'digitalocean',
  vultr: 'vultr',
  linode: 'akamai',
  contabo: 'contabo',
  scaleway: 'scaleway',
  cloudflare: 'cloudflare',
  netcup: 'netcup',
  'yandex-cloud': 'yandexcloud',
  'google-cloud': 'googlecloud',
  // Финансы
  paypal: 'paypal',
  okx: 'okx',
  binance: 'binance',
  coinbase: 'coinbase',
  ethereum: 'ethereum',
  bitcoin: 'bitcoin',
  tether: 'tether',
  // Подписки и сервисы
  spotify: 'spotify',
  netflix: 'netflix',
  youtube: 'youtube',
  github: 'github',
  telegram: 'telegram',
  notion: 'notion',
  figma: 'figma',
  jetbrains: 'jetbrains',
  namecheap: 'namecheap',
  cloudflare_pages: 'cloudflarepages',
  vk: 'vk',
  boosty: 'boosty',
  steam: 'steam'
}

// Бренды из Wikimedia Commons.
//
// `q`/`lang` — то, что уходит в поиск Wikidata; найденная сущность даёт свойство P154 («логотип»),
// а оно — имя файла на Commons. Это основной путь, и он работает ровно тогда, когда у компании
// в Wikidata прописан пригодный файл.
//
// `file` — закреплённый файл вместо P154. Нужен чаще, чем хотелось бы: в P154 обычно лежит
// ЛОГОТИП-НАДПИСЬ (пропорции 5:1 и хуже), а знак в приложении рисуется в квадратной ячейке
// 16–32 px. Надпись в такой ячейке сжимается до полоски высотой в три пикселя — формально
// логотип, фактически мусор. Поэтому там, где на Commons есть отдельная эмблема, берётся она,
// и в `why` записано, чем не подошёл P154: без этого следующий человек снимет закрепление и
// молча получит полоски.
//
// Набор CoreUI Icons целиком залит на Commons под CC BY 4.0 отдельными файлами «Cib-<бренд>».
// Это готовые ОДНОЦВЕТНЫЕ знаки 32×32 — ровно тот формат, который здесь нужен, поэтому там, где
// у бренда есть Cib-файл, берётся он, а не «официальный» логотип из P154.
const COMMONS = {
  // ── Собираются ───────────────────────────────────────────────────────────────────────────
  // P154 у AWS — двухцветный знак (тёмная надпись + оранжевая улыбка) под Apache-2.0.
  aws: { q: 'Amazon Web Services', lang: 'en', file: 'Cib-amazon-aws (CoreUI Icons v1.0.0).svg', why: 'P154 — знак из двух цветов' },

  // У Oracle P154 — надпись 512×66.
  oracle: { q: 'Oracle Corporation', lang: 'en', file: 'Cib-oracle (CoreUI Icons v1.0.0).svg', why: 'P154 — надпись 7.7:1' },

  // P154 = «Yandex logo 2021 Russian.svg» (367×106), а квадратная иконка «Я» на Commons — это
  // белая буква ПОВЕРХ красного круга, то есть два цвета.
  yandex: { q: 'Яндекс', lang: 'ru', file: 'Cib-yandex (CoreUI Icons v1.0.0).svg', why: 'P154 — надпись 3.5:1, иконка «Я» — два цвета' },

  // У сущности МегаФона P154 не заполнен вовсе; эмблема без надписи есть отдельным файлом.
  megafon: { q: 'МегаФон', lang: 'ru', file: 'MegaFon logo without text.svg', why: 'P154 пуст' },

  // У сущности Ozon P154 не заполнен. Надпись 2.3:1 — на грани, но читается.
  ozon: { q: 'Ozon', lang: 'en', file: 'OZONnew.svg', why: 'P154 пуст' },

  // ── Проверено, свободного пригодного файла нет ───────────────────────────────────────────
  // Записи оставлены НАМЕРЕННО: каждый прогон печатает, обо что именно спотыкается бренд, и
  // следующий человек не начинает поиск с нуля. Убрать их — значит через месяц снова обойти
  // Wikidata и Commons, чтобы прийти к тем же выводам. Если у кого-то из них на Commons
  // появится одноцветная эмблема, достаточно вписать `file` — код менять не нужно.

  // Официальный логотип — надпись 400×80 на градиентах. Латинский вариант со знаком нарисован
  // в Inkscape через вложенные transform: контуры сами по себе неверны.
  sberbank: { q: 'Сбербанк', lang: 'ru', file: 'Sberbank Logo latin.svg', why: 'P154 — надпись 5:1 на градиентах' },

  // Щит без надписи есть, но он двухцветный: тёмная «Т» вырезана поверх жёлтого щита, и в
  // монохроме буква сливается с основанием — остаётся пустой щит.
  tbank: { q: 'Т-Банк', lang: 'ru', file: 'T-Bank group logo.svg', why: 'P154 — надпись из шести контуров' },

  // Квадратный знак 2023 года: белые буквы вырезаны поверх красного квадрата, а сам квадрат —
  // <rect>, то есть не контур. В монохроме от знака остался бы только квадрат.
  mts: { q: 'МТС', lang: 'ru', file: 'Logo МТС (2023).svg', why: 'P154 отдаёт список, порядок в нём не гарантирован' },

  // P154 указывает на PNG. Единственный свободный SVG нарисован в CorelDRAW и держит часть
  // знака в <polygon> — при переносе в контуры она исчезнет.
  bybit: { q: 'Bybit', lang: 'en', file: 'Bybit Logo.svg', why: 'P154 — растр' },

  // P154 указывает на PNG, свободного SVG у ЮMoney на Commons нет вовсе.
  yoomoney: { q: 'ЮMoney', lang: 'ru' },

  // P154 = «Wildberries 2023 Pink.svg», надпись 500×75 (6.7:1). Эмблемы на Commons нет.
  wildberries: { q: 'Wildberries', lang: 'en' },

  // P154 указывает на PNG; поиск по названию отдаёт одноимённые компании (Brussels Airlines,
  // Beeline Software), и брать оттуда «похожий» файл было бы хуже отсутствия знака.
  beeline: { q: 'Билайн', lang: 'ru' },

  // У биржи в Wikidata P154 пуст, а поиск по Commons отдаёт кракенов из игр и ром.
  kraken: { q: 'Kraken', lang: 'en' }
}

// Одна форма адреса, без вариантов: `/<slug>` отдаёт SVG с фирменным цветом внутри. Форма
// `/<slug>/_/`, которую предлагают некоторые примеры, отвечает 404 — проверено.
const SIMPLE_SOURCE = (slug) => `https://cdn.simpleicons.org/${slug}`

// Wikimedia отвечает 403 на запросы без внятного User-Agent — это записано в их правилах
// (Wikimedia User-Agent policy) и проверяется на живых запросах. Строка должна называть
// программу и версию, а не притворяться браузером.
const UA = 'argus-brand-catalog/2.0 (Argus personal command center; local build script)'

/** Свободные лицензии, которые берём.
 *
 *  Share-alike (CC BY-SA) сюда НЕ входит намеренно: она требует распространять производное на
 *  тех же условиях, а производным здесь становится файл исходников приложения. Ради знака
 *  банка менять условия на весь каталог — плохая сделка, поэтому такие файлы пропускаются
 *  с явным сообщением, а не тихо.
 */
const FREE_LICENSE = /^(pd|public domain|cc0|cc[- ]by[- ]\d|attribution|apache|mit|bsd)/i
const SHARE_ALIKE = /(^|[-\s])(sa|share[- ]?alike)([-\s]|$)/i

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wikimedia отдаёт 429 при частых запросах, а канал у владельца ходит через туннель и иногда
 *  рвётся на ровном месте. Оба случая лечатся одним: пауза между запросами плюс повтор с
 *  нарастающей задержкой. Без этого прогон разваливается на середине списка — проверено. */
let lastCall = 0
async function fetchText(url, { json = false, gap = 1200, tries = 5 } = {}) {
  let last
  for (let attempt = 0; attempt < tries; attempt++) {
    const wait = lastCall + gap - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*' } })
      // 429 — «слишком часто», а не «нет такого»: повторять можно и нужно.
      if (res.status === 429) {
        last = new Error('HTTP 429 (слишком часто)')
        await sleep(3000 * (attempt + 1))
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return json ? await res.json() : await res.text()
    } catch (e) {
      last = e
      await sleep(2000 * (attempt + 1))
    }
  }
  throw last
}

const api = (host, params) =>
  fetchText(`https://${host}/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`, { json: true })

/** Сущность Wikidata по названию компании. Берём первого кандидата поиска — но печатаем его
 *  идентификатор, потому что «Kraken» в Wikidata это ещё и фильм, и род простейших. */
async function wikidataEntity(q, lang) {
  const found = await api('www.wikidata.org', {
    action: 'wbsearchentities',
    type: 'item',
    limit: '3',
    language: lang,
    uselang: lang,
    search: q
  })
  const hit = found.search?.[0]
  if (!hit) throw new Error(`Wikidata не знает «${q}»`)
  return hit.id
}

/** Файл логотипа из свойства P154. Отдаём только SVG: растр не красится цветом текста. */
async function logoFile(qid) {
  const got = await api('www.wikidata.org', {
    action: 'wbgetentities',
    props: 'claims',
    ids: qid
  })
  const claims = got.entities?.[qid]?.claims?.P154 ?? []
  const files = claims.map((c) => c.mainsnak?.datavalue?.value).filter((v) => typeof v === 'string')
  if (!files.length) throw new Error(`у ${qid} не заполнено P154 (логотип)`)
  const svg = files.find((f) => /\.svg$/i.test(f))
  if (!svg) throw new Error(`в P154 у ${qid} только растр: ${files.join(', ')}`)
  return svg
}

/** Лицензия файла на Commons. Неизвестная лицензия — это «нельзя», а не «наверное можно»:
 *  на Commons лежат и несвободные файлы (обложки, логотипы по fair use), и отличить их можно
 *  только спросив. */
async function license(file) {
  const got = await api('commons.wikimedia.org', {
    action: 'query',
    prop: 'imageinfo',
    iiprop: 'extmetadata',
    iiextmetadatafilter: 'LicenseShortName|License',
    titles: `File:${file}`
  })
  const page = Object.values(got.query?.pages ?? {})[0]
  if (!page || page.missing !== undefined) throw new Error(`на Commons нет файла «${file}»`)
  const meta = page.imageinfo?.[0]?.extmetadata ?? {}
  const short = meta.LicenseShortName?.value
  const code = meta.License?.value
  if (!short && !code) throw new Error(`у «${file}» не указана лицензия — считаем несвободной`)
  const name = short ?? code
  if (SHARE_ALIKE.test(code ?? '') || SHARE_ALIKE.test(short ?? ''))
    throw new Error(`лицензия «${name}» требует share-alike — на исходники приложения не берём`)
  if (!FREE_LICENSE.test(code ?? '') && !FREE_LICENSE.test(short ?? ''))
    throw new Error(`лицензия «${name}» не свободная`)
  return name
}

/** Значение атрибута, записанного хоть двойными кавычками, хоть одинарными: файлы на Commons
 *  приходят из Illustrator, Inkscape и CorelDRAW, и каждый пишет по-своему. Разбор, знающий
 *  только двойные кавычки, молча объявлял «нет viewBox» у совершенно исправного файла. */
const attr = (source, name) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, 'i')
    .exec(source)
    ?.slice(1)
    .find((v) => v !== undefined)

/** Достать из SVG контуры и фирменный цвет.
 *
 *  Разбор намеренно строгий: молча принять чужую разметку и вставить её в приложение — ровно то,
 *  чего этот формат и избегает. Каждая проверка ниже — про одно и то же: знак рисуется ОДНИМ
 *  цветом из viewBox и списка `d`, и всё, что в эту форму не влезает, при переносе исчезает
 *  молча — на экране оказывается не «чуть хуже», а пятно, в котором компанию не узнать.
 */
function parse(svg, { maxPaths = 3, maxRatio = 3 } = {}) {
  // Комментарии и метаданные Inkscape/Illustrator выкидываем до проверок: в них попадают и
  // слова вроде «transform», и куски старой разметки, из-за которых отвергался годный файл.
  const body = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
    .replace(/<(title|desc)\b[\s\S]*?<\/\1>/gi, '')

  // Всё, что мы НЕ переносим. Знак состоит только из контуров, поэтому фигура, текст, картинка
  // или ссылка на другой элемент — это часть логотипа, которая просто исчезнет.
  const shape = /<(rect|circle|ellipse|polygon|polyline|line|text|image|use)\b/i.exec(body)
  if (shape) throw new Error(`есть <${shape[1]}> — при переносе в контуры эта часть знака исчезнет`)
  // Градиент значит многоцветный знак: в монохроме он схлопывается в силуэт без внутренних границ.
  if (/<(linear|radial)Gradient\b/i.test(body)) throw new Error('знак на градиентах — в монохроме станет пятном')
  // Обрезка по маске задаёт видимую часть снаружи контура — унести можно только сам контур.
  if (/\bclip-path\s*=/i.test(body)) throw new Error('видимая часть задана обрезкой (clip-path), а не контуром')
  // Обводка — не заливка. `stroke="none"` при этом обычное дело и ничего не значит.
  const stroke = /\bstroke\s*[:=]\s*"?'?([^;"'\s>]+)/i.exec(body)?.[1]
  if (stroke && stroke.toLowerCase() !== 'none') throw new Error('знак нарисован обводкой, а не заливкой')
  // Смещения и повороты живут в атрибуте, а не в данных контура: перенесём `d` — получим кашу.
  if (/\btransform\s*=/i.test(body)) throw new Error('геометрия вынесена в transform — контуры сами по себе неверны')

  let vb = attr(body, 'viewBox')
  if (!vb) {
    // Часть файлов на Commons задаёт размер только через width/height (иногда в «px» или «mm»).
    // Это не повод отказываться: viewBox из них выводится однозначно.
    const svgTag = /<svg\b[^>]*>/i.exec(body)?.[0] ?? ''
    const w = parseFloat(attr(svgTag, 'width') ?? '')
    const h = parseFloat(attr(svgTag, 'height') ?? '')
    if (!(w > 0 && h > 0)) throw new Error('нет ни viewBox, ни размеров')
    vb = `0 0 ${w} ${h}`
  }
  const [, , vw, vh] = vb.trim().split(/[\s,]+/).map(Number)
  if (!(vw > 0 && vh > 0)) throw new Error(`испорченный viewBox «${vb}»`)

  // Знак рисуется в КВАДРАТНОЙ ячейке 16–32 px. Логотип-надпись пропорций 6:1 сжимается в ней
  // до полоски высотой три пикселя — она не читается и ломает ряд сильнее, чем её отсутствие.
  const ratio = vw / vh
  if (ratio > maxRatio || ratio < 1 / maxRatio)
    throw new Error(`пропорции ${ratio.toFixed(1)}:1 — в квадратной ячейке это полоска, а не знак`)

  // Цвет контура может лежать в трёх местах: на самом контуре, в классе из <style> и на
  // родительской группе. Нам не нужен сам цвет — нужно знать, СКОЛЬКО их: см. проверку ниже.
  const byClass = {}
  for (const rule of body.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const f = /fill\s*:\s*([^;}\s]+)/i.exec(rule[2])?.[1]
    if (f) byClass[rule[1]] = f
  }
  // `fill="none"` на <svg> или <g> — это «у самой группы заливки нет», обычная строчка
  // экспорта из Figma. К контурам она отношения не имеет, поэтому в наследование не идёт.
  const groups = [...body.matchAll(/<(?:svg|g)\b[^>]*>/gi)].map((m) => m[0])
  const inherited = groups.map((g) => attr(g, 'fill')).find((f) => f && f.toLowerCase() !== 'none')
  const groupAttrs = groups.join(' ')

  const paths = [...body.matchAll(/<path\b[^>]*?\bd\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/g)].map((m) => {
    const tag = m[0]
    const path = { d: m[1] ?? m[2] }
    // Правило заливки решает, будут ли дырки внутри буквы дырками. Потерять его — залить букву «О».
    // Оно же часто стоит на группе, а не на контуре, — тогда берём её.
    const rule = (name) => {
      const re = new RegExp(`${name}\\s*[:=]\\s*"?'?(evenodd|nonzero)`, 'i')
      return re.exec(tag)?.[1] ?? re.exec(groupAttrs)?.[1]
    }
    const fillRule = rule('fill-rule')
    if (fillRule) path.fillRule = fillRule.toLowerCase()
    const clipRule = rule('clip-rule')
    if (clipRule) path.clipRule = clipRule.toLowerCase()
    const own = attr(tag, 'fill') ?? /fill\s*:\s*([^;"'\s]+)/i.exec(tag)?.[1]
    const cls = attr(tag, 'class')
    path.fill = own ?? (cls ? byClass[cls.trim().split(/\s+/)[0]] : undefined) ?? inherited
    return path
  })
  if (!paths.length) throw new Error('нет контуров')
  if (paths.some((p) => (p.fill ?? '').toLowerCase() === 'none'))
    throw new Error('есть контуры с fill:none — в монохроме они станут видимыми')

  // Главная проверка. Знак красится ОДНИМ цветом, поэтому второй цвет в исходнике почти всегда
  // означает вырезанную деталь: белая «Я» поверх красного круга у Яндекса, тёмная «Т» поверх
  // жёлтого щита у Т-Банка. Сведи их в один цвет — и деталь сольётся с основанием, останется
  // силуэт, в котором компанию не узнать. Такие файлы пропускаем целиком: монограмма из двух
  // букв честнее пятна. Исключений «эти два цвета лежат рядом, а не друг на друге» не делаем —
  // отличить одно от другого можно только нарисовав.
  const colors = [...new Set(paths.map((p) => (p.fill ?? '').toLowerCase()).filter(Boolean))]
  if (colors.length > 1) throw new Error(`знак из ${colors.length} цветов (${colors.join(', ')}) — в монохроме детали сольются`)

  // Много контуров у одноцветного знака почти всегда значит «это надпись побуквенно»:
  // в ячейке 16 px такая надпись нечитаема.
  if (paths.length > maxPaths)
    throw new Error(`${paths.length} контуров — столько бывает у надписи, разобранной на буквы`)

  // Фирменный цвет нужен ровно одному месту (крупный знак в панели деталей ИИ); если в файле
  // цвета нет — знак и так рисуется цветом текста, а сюда кладём нейтральный.
  const tint = /^#[0-9a-fA-F]{3,8}$/.test(colors[0] ?? '') ? colors[0] : '#94a3b8'
  // Сам цвет из контуров убираем: знак наследует цвет текста, и вшитая заливка это ломала бы.
  for (const p of paths) delete p.fill
  return { vb, tint, paths }
}

/** Прошлый каталог, разобранный обратно в объекты.
 *
 *  Источник может лежать, отвечать 429 или потерять файл — и тогда единственно верное поведение
 *  «оставить как было»: перезаписать каталог половиной знаков значит сломать интерфейс из-за
 *  чужой недоступности. Формат генерации фиксирован («ключ: {json}» по строке), поэтому обратный
 *  разбор — это регулярка, а не парсер TypeScript.
 */
function previous() {
  try {
    const text = readFileSync(out, 'utf8')
    const old = {}
    for (const m of text.matchAll(/^ {2}'([^']+)': (\{.*?\}),?$/gm)) {
      try {
        old[m[1]] = JSON.parse(m[2])
      } catch {
        // Одна испорченная строка не повод терять остальные.
      }
    }
    return old
  } catch {
    return {}
  }
}

async function fromSimpleIcons(slug) {
  const svg = await fetchText(SIMPLE_SOURCE(slug), { gap: 150 })
  // У simple-icons формат свой и заведомо чистый: один контур, квадрат 24×24. Ослаблять здесь
  // проверки не нужно — они и так проходят, а если однажды не пройдут, это стоит увидеть.
  const mark = parse(svg)
  return { ...mark, license: 'CC0-1.0 (simple-icons)' }
}

async function fromCommons(key, cfg) {
  let file = cfg.file
  if (!file) {
    const qid = await wikidataEntity(cfg.q, cfg.lang)
    file = await logoFile(qid)
    console.log(`  ${key}: Wikidata ${qid} → P154 «${file}»`)
  }
  const lic = await license(file)
  // Адрес намеренно один и тот же для любого файла: Special:FilePath сам разворачивается в
  // текущее место хранения, а вычислять путь по хешу имени (как делают примеры в интернете)
  // значит ломаться при каждой перезаливке файла.
  const svg = await fetchText(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`)
  const mark = parse(svg)
  return { ...mark, license: `${lic} (Wikimedia Commons: ${file})` }
}

const kept = previous()
const catalog = {}
const failed = []
const reused = []

for (const [key, slug] of Object.entries(SIMPLE_ICONS)) {
  try {
    catalog[key] = await fromSimpleIcons(slug)
  } catch (e) {
    failed.push(`${key} (simple-icons/${slug}): ${e.message}`)
  }
}

console.log('Commons:')
for (const [key, cfg] of Object.entries(COMMONS)) {
  try {
    catalog[key] = await fromCommons(key, cfg)
    console.log(`  ${key}: взят${cfg.why ? ` закреплённый файл (${cfg.why})` : ''}`)
  } catch (e) {
    failed.push(`${key} (Commons «${cfg.file ?? cfg.q}»): ${e.message}`)
  }
}

// Что не собралось — остаётся из прошлого каталога, если там было.
for (const [key, mark] of Object.entries(kept)) {
  if (!catalog[key]) {
    catalog[key] = mark
    reused.push(key)
  }
}

const body = Object.entries(catalog)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, v]) => `  '${key}': ${JSON.stringify(v)}`)
  .join(',\n')

const licenses = [...new Set(Object.values(catalog).map((v) => (v.license ?? '?').replace(/ \(.*/, '')))].sort()

writeFileSync(
  out,
  `// СГЕНЕРИРОВАНО tools/build-brand-catalog.mjs — правки руками потеряются.
//
// Логотипы компаний, вшитые контурами. Источники — simple-icons (CC0-1.0) и Wikimedia Commons
// (свободные лицензии, у каждого знака записана своя в поле license). Сами файлы свободны от
// авторских прав либо распространяются с указанием авторства; товарные знаки остаются за их
// владельцами, и здесь они используются по прямому назначению — обозначить компанию, о которой
// идёт речь. Лицензии в наборе: ${licenses.join(', ')}.
//
// Знак рисуется цветом текста (currentColor), поэтому из исходных файлов взяты только контуры.
// Формат намеренно совпадает с assets/providers/marks.ts: viewBox + контуры + фирменный цвет.
// Собран ${new Date().toISOString().slice(0, 10)}, брендов: ${Object.keys(catalog).length}.
import type { ProviderMark } from '../providers/marks'

export const BRAND_MARKS: Record<string, ProviderMark> = {
${body}
}
`
)

console.log(`\nкаталог: ${Object.keys(catalog).length} брендов → ${out}`)
if (reused.length) console.log(`оставлено из прошлого каталога (${reused.length}): ${reused.join(', ')}`)
if (failed.length) console.log(`не собрано (${failed.length}):\n  ${failed.join('\n  ')}`)
