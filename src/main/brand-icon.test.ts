// Значок берётся по адресу, который называет ЧУЖАЯ страница. Это единственное место, где
// внешний документ управляет тем, куда пойдёт запрос, — и потому единственное, где нужен
// список того, куда ходить нельзя. На петле у приложения живут guacd и мост агента, в облаке
// по 169.254.169.254 отдают учётные данные машины.
import { describe, expect, it } from 'vitest'
import { cleanDomain, iconLinksFrom, publicHttpsUrl } from './brand-icon'

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
