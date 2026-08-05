// Значок берётся по адресу, который называет ЧУЖАЯ страница. Это единственное место, где
// внешний документ управляет тем, куда пойдёт запрос, — и потому единственное, где нужен
// список того, куда ходить нельзя. На петле у приложения живут guacd и мост агента, в облаке
// по 169.254.169.254 отдают учётные данные машины.
import { describe, expect, it } from 'vitest'
import { cleanDomain, iconLinksFrom, pngInsideIco, publicHttpsUrl } from './brand-icon'

describe('publicHttpsUrl', () => {
  it('пропускает обычный чужой CDN — на нём значки и лежат', () => {
    expect(publicHttpsUrl('https://cdn.tbank.ru/icons/apple-touch-icon-180x180.png')).toContain('cdn.tbank.ru')
    expect(publicHttpsUrl('https://www.paypalobjects.com/i/apple-touch-icon.png')).toContain('paypalobjects')
  })

  it('не пускает на петлю и в частные сети', () => {
    expect(publicHttpsUrl('https://127.0.0.1:4822/x.png')).toBeNull()
    expect(publicHttpsUrl('https://10.0.0.5/x.png')).toBeNull()
    expect(publicHttpsUrl('https://192.168.1.1/x.png')).toBeNull()
    expect(publicHttpsUrl('https://172.20.0.3/x.png')).toBeNull()
    expect(publicHttpsUrl('https://[::1]/x.png')).toBeNull()
  })

  it('не пускает к облачным метаданным', () => {
    // 169.254.169.254 отдаёт токены машины в AWS, GCP и Яндекс.Облаке.
    expect(publicHttpsUrl('https://169.254.169.254/latest/meta-data/x.png')).toBeNull()
    expect(publicHttpsUrl('https://metadata.google.internal/x.png')).toBeNull()
  })

  it('не пускает служебные имена локальной сети', () => {
    // Точка в них есть, поэтому проверкой «похоже на домен» они не отсеиваются.
    expect(publicHttpsUrl('https://router.lan/x.png')).toBeNull()
    expect(publicHttpsUrl('https://argus.local/x.png')).toBeNull()
    expect(publicHttpsUrl('https://localhost/x.png')).toBeNull()
  })

  it('пропускает только https', () => {
    // http дал бы подменить картинку любому на канале; file: к сети отношения не имеет вовсе.
    expect(publicHttpsUrl('http://bank.ru/x.png')).toBeNull()
    expect(publicHttpsUrl('file:///etc/x.png')).toBeNull()
    expect(publicHttpsUrl('data:image/png;base64,AAA')).toBeNull()
  })
})

describe('cleanDomain', () => {
  it('приводит написанное человеком к домену', () => {
    expect(cleanDomain('https://www.tbank.ru/mybank/')).toBe('tbank.ru')
    expect(cleanDomain('  BYBIT.com ')).toBe('bybit.com')
  })

  it('отвергает адреса, которые снаружи не бывают', () => {
    // Форма домена ничего не гарантирует: всё это её проходит.
    expect(cleanDomain('127.0.0.1')).toBeNull()
    expect(cleanDomain('10.0.0.5')).toBeNull()
    expect(cleanDomain('router.lan')).toBeNull()
    expect(cleanDomain('сбер')).toBeNull()
  })
})

describe('iconLinksFrom', () => {
  it('берёт значки со страницы, крупные первыми', () => {
    const html = `
      <link rel="icon" sizes="32x32" href="/favicon-32x32.png">
      <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.bank.ru/touch.png">`
    expect(iconLinksFrom(html, 'https://bank.ru/')).toEqual([
      'https://cdn.bank.ru/touch.png',
      'https://bank.ru/favicon-32x32.png'
    ])
  })

  it('выбрасывает ссылку, уводящую внутрь машины', () => {
    const html = `<link rel="icon" href="http://127.0.0.1:4822/x.png">
                  <link rel="icon" href="//169.254.169.254/latest.png">`
    expect(iconLinksFrom(html, 'https://bank.ru/')).toEqual([])
  })
})

describe('pngInsideIco', () => {
  // Собираем ICO руками: два кадра, крупный — второй. Сеть для этого не нужна, а формат
  // проверяется целиком, включая выбор самого большого кадра.
  const png = (marker: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([marker])])

  const ico = (frames: Array<{ width: number; data: Buffer }>): Buffer => {
    const header = Buffer.alloc(6 + frames.length * 16)
    header.writeUInt32LE(0x00010000, 0)
    header.writeUInt16LE(frames.length, 4)
    let offset = header.length
    frames.forEach((f, i) => {
      const e = 6 + i * 16
      header[e] = f.width === 256 ? 0 : f.width
      header.writeUInt32LE(f.data.length, e + 8)
      header.writeUInt32LE(offset, e + 12)
      offset += f.data.length
    })
    return Buffer.concat([header, ...frames.map((f) => f.data)])
  }

  it('достаёт самый крупный кадр', () => {
    const file = ico([
      { width: 16, data: png(1) },
      { width: 64, data: png(2) }
    ])
    expect(pngInsideIco(file)?.at(-1)).toBe(2)
  })

  it('нулевая ширина в заголовке означает 256, а не «меньше всех»', () => {
    // Ровно та ловушка формата: у кадра 256×256 в поле ширины стоит 0.
    const file = ico([
      { width: 128, data: png(1) },
      { width: 256, data: png(2) }
    ])
    expect(pngInsideIco(file)?.at(-1)).toBe(2)
  })

  it('старый ICO с BMP внутри не выдаётся за PNG', () => {
    const file = ico([{ width: 32, data: Buffer.from([0x28, 0, 0, 0, 0, 0, 0, 0, 0]) }])
    expect(pngInsideIco(file)).toBeNull()
  })

  it('обычный PNG не принимается за ICO', () => {
    expect(pngInsideIco(png(1))).toBeNull()
  })
})
