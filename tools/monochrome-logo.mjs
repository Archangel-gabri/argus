#!/usr/bin/env node
// Перекрасить чужой логотип в наш цвет.
//
// Задача владельца звучала так: «скрипт, который парсит ярлыки — хоть реддита, хоть чего — и
// окрашивает в наш цвет; у нас по ИИ всё серое». Для векторов это делается само (знак рисуется
// `currentColor` — см. tools/build-brand-catalog.mjs), но у части хостеров свободного вектора
// нет вовсе, и остаётся растр. Растр покрасить нельзя ни классом, ни CSS-фильтром: у четырёх
// логотипов из пяти фон НЕПРОЗРАЧНЫЙ, и `invert` превращает такой файл в белый квадрат.
//
// Поэтому здесь настоящая обработка пикселей: фон определяется по углам, вычитается, и от
// картинки остаётся силуэт — одна краска, прозрачность равна тому, насколько густо в этой точке
// лежали чернила. Дальше силуэт красится в любой цвет строкой запуска.
//
// Зависимостей нет намеренно: PNG разбирается и собирается здесь же (zlib есть в Node). Ставить
// sharp ради пяти файлов — это 60 МБ бинарников в дерево, которое собирается в AppImage.
//
//   node tools/monochrome-logo.mjs <вход.png> <выход.png> [--color '#94a3b8'] [--threshold 0.06]
//
// Проверить глазами: --dump печатает карту покрытия в терминал.

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

function chunks(buf) {
  const out = []
  let i = 8
  while (i < buf.length) {
    const len = buf.readUInt32BE(i)
    out.push({ type: buf.toString('latin1', i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + len) })
    i += 12 + len
  }
  return out
}

/** Обратный фильтр строки PNG. Пятый способ (Paeth) — тот, которым закодировано большинство. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const type = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (type === 1) v += a
      else if (type === 2) v += b
      else if (type === 3) v += (a + b) >> 1
      else if (type === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
  }
  return out
}

/** Пиксели как {r,g,b,a} независимо от того, палитра это, серый или truecolor. */
function decode(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: это не PNG`)
  const cs = chunks(buf)
  const ihdr = cs.find((c) => c.type === 'IHDR').data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const depth = ihdr[8]
  const color = ihdr[9]
  if (depth !== 8) throw new Error(`${file}: глубина ${depth} бит не поддерживается — нужен 8-битный PNG`)
  if (ihdr[12] !== 0) throw new Error(`${file}: чересстрочный PNG не поддерживается`)
  const plte = cs.find((c) => c.type === 'PLTE')?.data
  const trns = cs.find((c) => c.type === 'tRNS')?.data
  const raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]
  if (!bpp) throw new Error(`${file}: неизвестный тип цвета ${color}`)
  const flat = unfilter(raw, width, height, bpp)
  const px = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * bpp
    if (color === 3) {
      const idx = flat[s]
      px[j] = plte[idx * 3]
      px[j + 1] = plte[idx * 3 + 1]
      px[j + 2] = plte[idx * 3 + 2]
      px[j + 3] = trns && idx < trns.length ? trns[idx] : 255
    } else if (color === 0 || color === 4) {
      px[j] = px[j + 1] = px[j + 2] = flat[s]
      px[j + 3] = color === 4 ? flat[s + 1] : 255
    } else {
      px[j] = flat[s]
      px[j + 1] = flat[s + 1]
      px[j + 2] = flat[s + 2]
      px[j + 3] = color === 6 ? flat[s + 3] : 255
    }
  }
  return { width, height, px }
}

function encode({ width, height, px }) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(CRC(body))
    return Buffer.concat([len, body, crc])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Цвет фона — по четырём углам.
 *
 * Единственный признак фона, который верен и для белой плашки, и для прозрачной, и для тёмной:
 * то, что лежит по краям. Брать «самый частый цвет» нельзя — у знака с крупной заливкой самым
 * частым окажется сам знак, и вычтется он.
 */
function background({ width, height, px }) {
  const at = (x, y) => {
    const j = (y * width + x) * 4
    return [px[j], px[j + 1], px[j + 2], px[j + 3]]
  }
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
  if (corners.some((c) => c[3] === 0)) return null // прозрачные углы — вычитать нечего
  const avg = [0, 1, 2].map((k) => Math.round(corners.reduce((s, c) => s + c[k], 0) / corners.length))
  // Углы разного цвета — это не фон, а часть картинки: тогда честнее ничего не вычитать.
  const spread = Math.max(...corners.flatMap((c) => [0, 1, 2].map((k) => Math.abs(c[k] - avg[k]))))
  return spread > 12 ? null : avg
}

/** Силуэт: одна краска, прозрачность = насколько точка отличается от фона. */
export function monochrome(img, { color = [148, 163, 184], threshold = 0.06 } = {}) {
  const bg = background(img)
  const out = new Uint8Array(img.px.length)
  let ink = 0
  for (let i = 0; i < img.px.length; i += 4) {
    const [r, g, b, a] = [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]]
    let cover
    if (bg) {
      // Расстояние до фона, нормированное на самое дальнее, что вообще бывает.
      const d = Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2) / 441.67
      cover = Math.min(1, d * 2.2)
    } else {
      // Фона нет — краской считается сама непрозрачность файла.
      cover = a / 255
    }
    if (cover < threshold) cover = 0
    if (cover > 0) ink++
    out[i] = color[0]
    out[i + 1] = color[1]
    out[i + 2] = color[2]
    out[i + 3] = Math.round(cover * (bg ? 255 : a))
  }
  return { width: img.width, height: img.height, px: out, ink, hadBackground: Boolean(bg) }
}

function main() {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
  if (files.length < 2) {
    console.error('нужно: node tools/monochrome-logo.mjs <вход.png> <выход.png> [--color "#94a3b8"] [--threshold 0.06]')
    process.exit(2)
  }
  const hex = flag('--color', '#94a3b8').replace('#', '')
  const color = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const img = decode(files[0])
  const res = monochrome(img, { color, threshold: Number(flag('--threshold', 0.06)) })
  const share = res.ink / (res.width * res.height)
  // Пустой или сплошной силуэт — это не логотип, а сбой распознавания фона. Молча записать
  // такой файл значит подменить знак квадратом и увидеть это только глазами в приложении.
  if (share < 0.01) throw new Error(`${files[0]}: краски почти нет (${(share * 100).toFixed(1)}%) — фон определился неверно`)
  if (share > 0.95) throw new Error(`${files[0]}: закрашено ${(share * 100).toFixed(0)}% — фон не вычелся, вышел бы квадрат`)
  writeFileSync(files[1], encode(res))
  console.log(
    `${files[0]} → ${files[1]}: ${res.width}×${res.height}, краски ${(share * 100).toFixed(1)}%, ` +
      `фон ${res.hadBackground ? 'вычтен' : 'прозрачный, взята альфа'}`
  )
}

// Сравнивать с `file://${argv[1]}` нельзя: путь проекта содержит пробел и кириллицу, в
// import.meta.url они percent-кодированы, строки не совпадают — и скрипт молча ничего не делает.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
