// Per-hoster accent + monogram (stand-ins for real logos; swappable later).
const HEX: Record<string, string> = {
  Hetzner: '#e11d48',
  'Yandex Cloud': '#f5c518',
  FlokiNET: '#14b8a6',
  ExtraVM: '#6366f1',
  OVH: '#2563eb',
  FirstByte: '#a855f7'
}

const GLYPH: Record<string, string> = {
  Hetzner: 'Hz',
  'Yandex Cloud': 'Y',
  FlokiNET: 'Fl',
  ExtraVM: 'Ex',
  OVH: 'OVH',
  FirstByte: 'Fb'
}

export const providerHex = (p: string): string => HEX[p] ?? '#f59e0b'
export const providerGlyph = (p: string): string => GLYPH[p] ?? p.slice(0, 2)

// Домены известных хостеров → авто-логотип. Расширенная карта (в т.ч. RU-хостеры и гиперскейлеры);
// неизвестные одно-словные — эвристика <слово>.com. Clearbit убран (Logo API закрыт 2025-12-01).
const DOMAIN: Record<string, string> = {
  Hetzner: 'hetzner.com',
  'Yandex Cloud': 'yandex.cloud',
  Yandex: 'yandex.cloud',
  FlokiNET: 'flokinet.is',
  ExtraVM: 'extravm.com',
  OVH: 'ovhcloud.com',
  FirstByte: 'firstbyte.host',
  'First Server': 'firstvds.ru',
  FirstVDS: 'firstvds.ru',
  DigitalOcean: 'digitalocean.com',
  Vultr: 'vultr.com',
  Linode: 'linode.com',
  Akamai: 'linode.com',
  Contabo: 'contabo.com',
  Aeza: 'aeza.net',
  Selectel: 'selectel.ru',
  Timeweb: 'timeweb.com',
  RuVDS: 'ruvds.com',
  Beget: 'beget.com',
  Hostkey: 'hostkey.com',
  M247: 'm247.com',
  Netcup: 'netcup.de',
  Scaleway: 'scaleway.com',
  Cloudflare: 'cloudflare.com',
  AWS: 'aws.amazon.com',
  Amazon: 'aws.amazon.com',
  'Google Cloud': 'cloud.google.com',
  Google: 'google.com',
  Azure: 'azure.microsoft.com',
  Oracle: 'oracle.com',
  THEHosting: 'the.hosting'
}

/** Домен хостера для логотипа: карта или эвристика (одно слово → .com). null если не угадать. */
export function providerDomain(p: string): string | null {
  if (DOMAIN[p]) return DOMAIN[p]
  const one = p.trim().toLowerCase().replace(/\s+/g, '')
  if (/^[a-z0-9-]{2,}$/.test(one)) return `${one}.com`
  return null
}

/** URL логотипа хостера по домену. Google s2 favicons — реальные фавиконки любого домена,
 *  HTTPS/CSP-ok, стабильны. Для bundled-хостеров всё равно приоритетен локальный лого (ServerCard). */
export function providerLogoUrl(p: string): string | null {
  const d = providerDomain(p)
  return d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128` : null
}
