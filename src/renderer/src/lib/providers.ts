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

