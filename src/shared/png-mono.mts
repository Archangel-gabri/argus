// Разбор и сборка PNG + приведение к одной краске.
//
// Живёт здесь, а не в инструменте, потому что нужен обоим: `tools/monochrome-logo.mjs` красит
// логотипы поставки заранее, а `src/main/brand-icon.ts` — значки, скачанные с сайтов компаний,
// уже во время работы. Две копии одного алгоритма разошлись бы молча, и логотипы из поставки
// выглядели бы иначе, чем подтянутые.
//
// Зависимостей нет намеренно: zlib есть в Node, а sharp — это 60 МБ бинарников в дереве,
// которое пакуется в AppImage.

import { deflateSync, inflateSync } from 'node:zlib'

export interface Bitmap {
  width: number
  height: number
  px: Uint8Array
}

export interface Silhouette extends Bitmap {
  /** Сколько точек получили краску — по этой доле видно, что фон определился неверно. */
  ink: number
  hadBackground: boolean
}

const CRC = ((): ((buf: Uint8Array) => number) => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf: Uint8Array): number => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

function chunks(buf: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = []
  let i = 8
  while (i < buf.length) {
    const len = buf.readUInt32BE(i)
    out.push({ type: buf.toString('latin1', i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + len) })
    i += 12 + len
  }
  return out
}

/** Обратный фильтр строки PNG. Пятый способ (Paeth) — тот, которым закодировано большинство. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
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
export function decodePng(buf: Buffer): Bitmap {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('это не PNG')
  const cs = chunks(buf)
  const ihdr = cs.find((c) => c.type === 'IHDR')?.data
  if (!ihdr) throw new Error('в PNG нет заголовка')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const depth = ihdr[8]
  const color = ihdr[9]
  if (depth !== 8) throw new Error(`глубина ${depth} бит не поддерживается — нужен 8-битный PNG`)
  if (ihdr[12] !== 0) throw new Error('чересстрочный PNG не поддерживается')
  const plte = cs.find((c) => c.type === 'PLTE')?.data
  const trns = cs.find((c) => c.type === 'tRNS')?.data
  const raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const bpp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]
  if (!bpp) throw new Error(`неизвестный тип цвета ${color}`)
  const flat = unfilter(raw, width, height, bpp)
  const px = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * bpp
    if (color === 3) {
      if (!plte) throw new Error('палитровый PNG без палитры')
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

export function encodePng({ width, height, px }: Bitmap): Buffer {
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
  const chunk = (type: string, data: Buffer): Buffer => {
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
 * Цвет фона — по ПЕРИМЕТРУ, а не по четырём углам.
 *
 * Углов мало. Значок банка часто нарисован «плашкой»: фирменный квадрат целиком, знак вырезан
 * белым поверх (жёлтый квадрат Т-Банка, синий PayPal). У такого файла углы бывают прозрачными
 * из-за скруглений — по прозрачности фон не находился вовсе, краской считалась вся заливка, и
 * силуэт выходил сплошным квадратом. Смотреть на всю рамку надёжнее: она и есть фон, чем бы он
 * ни был — прозрачностью или сплошной заливкой.
 *
 * Возвращаем `null`, если рамка в основном прозрачна (обычный логотип с альфой — там вычитать
 * нечего) или если она пёстрая (значит, рамка это часть картинки, и вычитание испортит знак).
 */
function background({ width, height, px }: Bitmap): number[] | null {
  const edge: number[][] = []
  const at = (x: number, y: number): number[] => {
    const j = (y * width + x) * 4
    return [px[j], px[j + 1], px[j + 2], px[j + 3]]
  }
  for (let x = 0; x < width; x++) {
    edge.push(at(x, 0), at(x, height - 1))
  }
  for (let y = 1; y < height - 1; y++) {
    edge.push(at(0, y), at(width - 1, y))
  }
  const opaque = edge.filter((c) => c[3] > 8)
  if (opaque.length < edge.length * 0.5) return null

  // Самый частый цвет рамки. Округляем до 8 уровней на канал: у сжатых значков соседние точки
  // фона отличаются на единицы, и без огрубления «самым частым» окажется случайный оттенок.
  const key = (c: number[]): string => `${c[0] >> 5}.${c[1] >> 5}.${c[2] >> 5}`
  const counts = new Map<string, { n: number; sum: number[] }>()
  for (const c of opaque) {
    const k = key(c)
    const cur = counts.get(k) ?? { n: 0, sum: [0, 0, 0] }
    cur.n++
    for (let i = 0; i < 3; i++) cur.sum[i] += c[i]
    counts.set(k, cur)
  }
  let best = { n: 0, sum: [0, 0, 0] }
  for (const v of counts.values()) if (v.n > best.n) best = v
  // Пёстрая рамка — это не фон. Порог низкий: у значка с заливкой одноцветны почти все точки.
  if (best.n < opaque.length * 0.6) return null
  return best.sum.map((v) => Math.round(v / best.n))
}

/** Силуэт: одна краска, прозрачность = насколько точка отличается от фона. */
export function monochrome(
  img: Bitmap,
  { color = [148, 163, 184], threshold = 0.06 }: { color?: number[]; threshold?: number } = {}
): Silhouette {
  const bg = background(img)
  const out = new Uint8Array(img.px.length)
  let ink = 0
  for (let i = 0; i < img.px.length; i += 4) {
    const [r, g, b, a] = [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]]
    let cover: number
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
