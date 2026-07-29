// Seed data modelled on the real fleet (IPs masked for safety in screenshots).
// In Electron the encrypted DB is the source of truth; this is only the browser-preview fallback.

import type { DeviceDTO } from '@/types'

export type Status = 'online' | 'offline' | 'reboot'
export type Currency = 'USD' | 'EUR' | 'RUB'

export interface Cost {
  amount: number
  currency: Currency
  usd: number // normalised for totals
  period: 'mo'
}

export interface Server {
  id: string
  name: string
  provider: string // hoster — drives the card glyph + spend grouping
  role?: string
  ip: string
  country: string
  flag: string
  os: string
  status: Status
  cpu: number // %
  ram: { used: number; total: number } // GB
  cost: Cost
  consoleUrl: string
  user: string
}

export const servers: Server[] = [
  {
    id: 'hub-de',
    name: 'HubVPN · Germany',
    provider: 'Hetzner',
    role: 'master',
    ip: '157.90.x.x',
    country: 'Germany',
    flag: '🇩🇪',
    os: 'Ubuntu 22.04',
    status: 'online',
    cpu: 18,
    ram: { used: 1.9, total: 4 },
    cost: { amount: 8.2, currency: 'EUR', usd: 9, period: 'mo' },
    consoleUrl: 'https://console.hetzner.cloud',
    user: 'root'
  },
  {
    id: 'hub-msk',
    name: 'HubVPN · Moscow',
    provider: 'Yandex Cloud',
    role: 'cascade',
    ip: '51.250.x.x',
    country: 'Russia',
    flag: '🇷🇺',
    os: 'Ubuntu 24.04',
    status: 'online',
    cpu: 34,
    ram: { used: 2.7, total: 4 },
    cost: { amount: 5000, currency: 'RUB', usd: 63, period: 'mo' },
    consoleUrl: 'https://console.yandex.cloud',
    user: 'root'
  },
  {
    id: 'hub-fi',
    name: 'HubVPN · Finland',
    provider: 'FlokiNET',
    role: 'exit',
    ip: '95.211.x.x',
    country: 'Finland',
    flag: '🇫🇮',
    os: 'Debian 12',
    status: 'online',
    cpu: 9,
    ram: { used: 0.8, total: 2 },
    cost: { amount: 8.99, currency: 'EUR', usd: 9.7, period: 'mo' },
    consoleUrl: 'https://billing.flokinet.is',
    user: 'root'
  },
  {
    id: 'hub-jp',
    name: 'HubVPN · Japan',
    provider: 'ExtraVM',
    role: 'exit · XHTTP',
    ip: '45.76.x.x',
    country: 'Japan',
    flag: '🇯🇵',
    os: 'Ubuntu 22.04',
    status: 'online',
    cpu: 12,
    ram: { used: 0.6, total: 1 },
    cost: { amount: 3.99, currency: 'USD', usd: 3.99, period: 'mo' },
    consoleUrl: 'https://my.extravm.com',
    user: 'root'
  },
  {
    id: 'ovh-node',
    name: 'HubVPN · OVH',
    provider: 'OVH',
    role: 'exit',
    ip: '51.83.x.x',
    country: 'France',
    flag: '🇫🇷',
    os: 'Debian 12',
    status: 'reboot',
    cpu: 0,
    ram: { used: 0, total: 2 },
    cost: { amount: 10, currency: 'EUR', usd: 10.8, period: 'mo' },
    consoleUrl: 'https://www.ovh.com/manager',
    user: 'debian'
  },
  {
    id: 'fx-ny',
    name: 'FX-Analytics',
    provider: 'FirstByte',
    role: 'app · cockpit',
    ip: '46.17.x.x',
    country: 'USA · NY',
    flag: '🇺🇸',
    os: 'Ubuntu 22.04',
    status: 'online',
    cpu: 41,
    ram: { used: 3.2, total: 8 },
    cost: { amount: 12, currency: 'USD', usd: 12, period: 'mo' },
    consoleUrl: 'https://panel.firstbyte.host',
    user: 'root'
  }
]

export const totalMonthlyUsd = servers.reduce((s, x) => s + x.cost.usd, 0)
export const totalYearlyUsd = totalMonthlyUsd * 12

/** Monthly spend grouped by hoster, for the Infrastructure Spend pie. */
export const spendByProvider = Object.values(
  servers.reduce<Record<string, { provider: string; usd: number }>>((acc, s) => {
    acc[s.provider] ??= { provider: s.provider, usd: 0 }
    acc[s.provider].usd += s.cost.usd
    return acc
  }, {})
).sort((a, b) => b.usd - a.usd)

/** Browser-preview fallback (no Electron API): the same fleet shaped as DeviceDTO[]. */
const SERVER_DEVICES: DeviceDTO[] = servers.map((s) => ({
  id: s.id,
  name: s.name,
  provider: s.provider,
  role: s.role ?? null,
  kind: 'server',
  ip: s.ip,
  port: 22,
  user: s.user,
  country: s.country,
  flag: s.flag,
  os: s.os,
  status: s.status,
  cpu: s.cpu,
  ram: s.ram,
  cost: s.cost,
  consoleUrl: s.consoleUrl,
  authType: 'none',
  hasSecret: false,
  notes: null,
  jumpId: null,
  altOs: [],
  mac: null
}))

/** Персональные/сетевые превью-девайсы (паспорт-карточки Fleet). */
const PERSONAL_DEVICES: DeviceDTO[] = [
  {
    id: 'pc-castiel',
    name: 'PC Castiel',
    provider: 'Home',
    role: 'dual-boot',
    kind: 'pc',
    ip: '100.79.x.x',
    port: 22,
    user: 'castiel',
    country: 'Home',
    flag: '🏠',
    os: 'Arch + Windows 11',
    status: 'unknown',
    cpu: 0,
    ram: { used: 0, total: 32 },
    cost: { amount: 0, currency: 'USD', usd: 0 },
    consoleUrl: '',
    authType: 'none',
    hasSecret: false,
    notes: 'i9-11900K · RTX 3060 · dual-boot · WoL',
    jumpId: null,
    altOs: [{ ip: '100.74.94.24', user: 'kubra', os: 'Windows 11' }],
    mac: '18:C0:4D:89:ED:6F'
  },
  {
    id: 'galaxy-s8',
    name: 'Galaxy S8',
    provider: 'Samsung',
    role: null,
    kind: 'other',
    ip: '',
    port: 22,
    user: '',
    country: 'Home',
    flag: '📱',
    os: 'Android 9',
    status: 'unknown',
    cpu: 0,
    ram: { used: 0, total: 4 },
    cost: { amount: 0, currency: 'USD', usd: 0 },
    consoleUrl: '',
    authType: 'none',
    hasSecret: false,
    notes: 'KDE Connect · WoL-пульт для ПК',
    jumpId: null,
    altOs: [],
    mac: null
  },
  {
    id: 'dlink-825',
    name: 'D-Link DIR-825',
    provider: 'D-Link',
    role: 'router',
    kind: 'router',
    ip: '192.168.0.1',
    port: 22,
    user: 'admin',
    country: 'Home',
    flag: '🌐',
    os: 'stock fw',
    status: 'unknown',
    cpu: 0,
    ram: { used: 0, total: 0 },
    cost: { amount: 0, currency: 'USD', usd: 0 },
    consoleUrl: 'http://192.168.0.1',
    authType: 'none',
    hasSecret: false,
    notes: 'Главный гигабитный роутер · DNS 8.8.8.8',
    jumpId: null,
    altOs: [],
    mac: null
  }
]

export const FALLBACK_DEVICES: DeviceDTO[] = [...SERVER_DEVICES, ...PERSONAL_DEVICES]
