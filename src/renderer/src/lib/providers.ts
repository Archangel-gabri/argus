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

// Домены известных хостеров → авто-логотип (Clearbit). Неизвестные — угадываем single-word.com.
const DOMAIN: Record<string, string> = {
  Hetzner: 'hetzner.com',
  'Yandex Cloud': 'yandex.cloud',
  FlokiNET: 'flokinet.is',
  ExtraVM: 'extravm.com',
  OVH: 'ovh.com',
  FirstByte: 'firstbyte.host',
  'First Server': 'firstvds.ru',
  DigitalOcean: 'digitalocean.com',
  Vultr: 'vultr.com',
  Linode: 'linode.com',
  Contabo: 'contabo.com',
  Aeza: 'aeza.net'
}

/** Домен хостера для логотипа: карта или эвристика (одно слово → .com). null если не угадать. */
export function providerDomain(p: string): string | null {
  if (DOMAIN[p]) return DOMAIN[p]
  const one = p.trim().toLowerCase()
  if (/^[a-z0-9-]{2,}$/.test(one)) return `${one}.com`
  return null
}

/** URL логотипа хостера по домену (Clearbit — реальные лого, HTTPS, CSP-ok). */
export function providerLogoUrl(p: string): string | null {
  const d = providerDomain(p)
  return d ? `https://logo.clearbit.com/${d}` : null
}
