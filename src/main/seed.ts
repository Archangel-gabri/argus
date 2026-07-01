import type { Currency, Status } from './types'

export interface SeedDevice {
  id: string
  name: string
  provider: string
  role: string | null
  ip: string
  port: number
  user: string
  country: string
  flag: string
  os: string
  status: Status
  cpu: number
  ram_used: number
  ram_total: number
  cost_amount: number
  cost_currency: Currency
  cost_usd: number
  console_url: string
}

// First-run fleet (modelled on the real infra; IPs masked). Stored on initialize().
export const SEED_DEVICES: SeedDevice[] = [
  { id: 'hub-de', name: 'HubVPN · Germany', provider: 'Hetzner', role: 'master', ip: '157.90.x.x', port: 22, user: 'root', country: 'Germany', flag: '🇩🇪', os: 'Ubuntu 22.04', status: 'online', cpu: 18, ram_used: 1.9, ram_total: 4, cost_amount: 8.2, cost_currency: 'EUR', cost_usd: 9, console_url: 'https://console.hetzner.cloud' },
  { id: 'hub-msk', name: 'HubVPN · Moscow', provider: 'Yandex Cloud', role: 'cascade', ip: '51.250.x.x', port: 22, user: 'root', country: 'Russia', flag: '🇷🇺', os: 'Ubuntu 24.04', status: 'online', cpu: 34, ram_used: 2.7, ram_total: 4, cost_amount: 5000, cost_currency: 'RUB', cost_usd: 63, console_url: 'https://console.yandex.cloud' },
  { id: 'hub-fi', name: 'HubVPN · Finland', provider: 'FlokiNET', role: 'exit', ip: '95.211.x.x', port: 22, user: 'root', country: 'Finland', flag: '🇫🇮', os: 'Debian 12', status: 'online', cpu: 9, ram_used: 0.8, ram_total: 2, cost_amount: 8.99, cost_currency: 'EUR', cost_usd: 9.7, console_url: 'https://billing.flokinet.is' },
  { id: 'hub-jp', name: 'HubVPN · Japan', provider: 'ExtraVM', role: 'exit · XHTTP', ip: '45.76.x.x', port: 22, user: 'root', country: 'Japan', flag: '🇯🇵', os: 'Ubuntu 22.04', status: 'online', cpu: 12, ram_used: 0.6, ram_total: 1, cost_amount: 3.99, cost_currency: 'USD', cost_usd: 3.99, console_url: 'https://my.extravm.com' },
  { id: 'ovh-node', name: 'HubVPN · OVH', provider: 'OVH', role: 'exit', ip: '51.83.x.x', port: 22, user: 'debian', country: 'France', flag: '🇫🇷', os: 'Debian 12', status: 'reboot', cpu: 0, ram_used: 0, ram_total: 2, cost_amount: 10, cost_currency: 'EUR', cost_usd: 10.8, console_url: 'https://www.ovh.com/manager' },
  { id: 'fx-ny', name: 'FX-Analytics', provider: 'FirstByte', role: 'app · cockpit', ip: '46.17.x.x', port: 22, user: 'root', country: 'USA · NY', flag: '🇺🇸', os: 'Ubuntu 22.04', status: 'online', cpu: 41, ram_used: 3.2, ram_total: 8, cost_amount: 12, cost_currency: 'USD', cost_usd: 12, console_url: 'https://panel.firstbyte.host' }
]
