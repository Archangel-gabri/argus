export type Status = 'online' | 'degraded' | 'offline' | 'reboot' | 'unknown' | 'maintenance'
// ~20 популярных валют (нормализация в USD — статичные приблизит. курсы в vault.ts FX).
export type Currency =
  | 'USD' | 'EUR' | 'RUB' | 'GBP' | 'CNY' | 'JPY' | 'CHF' | 'CAD' | 'AUD' | 'INR'
  | 'BRL' | 'KRW' | 'TRY' | 'PLN' | 'UAH' | 'KZT' | 'AED' | 'SEK' | 'NOK' | 'SGD'
export type AuthType = 'password' | 'key' | 'none'
/** Класс сущности во Fleet: servers = server; network = router; остальное = personal. */
export type DeviceKind = 'server' | 'pc' | 'phone' | 'watch' | 'buds' | 'router' | 'other'

/** Доп. эндпоинт ОС для multi-boot ПК (одна железка, несколько ОС). Тот же ключ, что у основного.
 *  bootEntry — подсказка grub-menuentry для переключения (иначе матчим по имени ОС). */
export interface AltBoot {
  ip: string
  user: string
  os: string
  bootEntry?: string
}

/** Full row as stored in the encrypted DB (includes secrets — main process only). */
export interface DeviceRow {
  id: string
  name: string
  provider: string
  role: string | null
  kind: DeviceKind
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
  auth_type: AuthType
  secret_password: string | null
  secret_key: string | null
  secret_passphrase: string | null
  notes: string | null
  jump_id: string | null
  /** JSON AltBoot[] | null — доп. эндпоинты ОС (multi-boot ПК). */
  alt: string | null
  mac: string | null
  sort: number
  created_at: number
  updated_at: number
}

/** What the renderer is allowed to see — NO secret material ever crosses IPC. */
export interface DeviceDTO {
  id: string
  name: string
  provider: string
  role: string | null
  kind: DeviceKind
  ip: string
  port: number
  user: string
  country: string
  flag: string
  os: string
  status: Status
  cpu: number
  ram: { used: number; total: number }
  cost: { amount: number; currency: Currency; usd: number }
  consoleUrl: string
  authType: AuthType
  hasSecret: boolean
  notes: string | null
  jumpId: string | null
  /** Доп. эндпоинты ОС (multi-boot ПК) — без секретов, только адрес/юзер/ОС. Пусто = одна ОС. */
  altOs: AltBoot[]
  /** MAC для Wake-on-LAN («Включить» из выключенного). */
  mac: string | null
  /** Эфемерно (только в renderer-сторе, не из БД): какая ОС сейчас РЕАЛЬНО запущена (multi-boot). */
  runningOs?: string | null
  /** Эфемерно: диск % занято и аптайм (сек) из последней пробы. */
  disk?: number | null
  uptime?: number | null
}

/** Renderer → main payload for create/update. May carry a secret to STORE (never to read back). */
export interface DeviceInput {
  name: string
  provider: string
  role?: string | null
  kind?: DeviceKind
  ip?: string
  port?: number
  user?: string
  country?: string
  flag?: string
  os?: string
  status?: Status
  cpu?: number
  ram?: { used: number; total: number }
  cost?: { amount: number; currency: Currency; usd: number }
  consoleUrl?: string
  authType?: AuthType
  password?: string | null
  /** PEM/OpenSSH private key to STORE (encrypted). Never read back to the renderer. */
  privateKey?: string | null
  /** Passphrase protecting the private key, if any. Stored encrypted alongside it. */
  passphrase?: string | null
  notes?: string | null
  jumpId?: string | null
  altOs?: AltBoot[]
  mac?: string | null
}

export interface Snippet {
  id: string
  name: string
  command: string
}

export interface Subscription {
  id: string
  name: string
  provider: string
  category: string
  amount: number
  currency: Currency
  period: 'mo' | 'yr'
  nextRenewal: string | null
  notes: string | null
}

export interface SubscriptionInput {
  name: string
  provider?: string
  category?: string
  amount: number
  currency?: Currency
  period?: 'mo' | 'yr'
  nextRenewal?: string | null
  notes?: string | null
}

export interface Wallet {
  id: string
  chain: string
  address: string
  label: string
}
export interface WalletInput {
  chain: string
  address: string
  label?: string
}
export interface WalletBalance {
  native: number
  symbol: string
  usd: number | null
}

export interface MetricSnapshot {
  ts: number
  cpu: number | null
  ramUsed: number | null
  ramTotal: number | null
  status: string
}

export interface AiAccount {
  id: string
  provider: string
  label: string
  plan: string
  hasKey: boolean
  notes: string | null
}
export interface AiAccountInput {
  provider: string
  label?: string
  apiKey?: string
  plan?: string
  notes?: string | null
}
export interface AiCheck {
  status: 'valid' | 'invalid' | 'quota' | 'error' | 'nokey'
  remaining?: number | null
  usage?: number | null
  detail?: string
}

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

export interface VaultState {
  status: VaultStatus
  /** OS keyring backend reported by safeStorage (e.g. 'kwallet', 'basic_text'). */
  keyringBackend: string
  /** True when safeStorage encryption is trustworthy (not the plaintext fallback). */
  canRemember: boolean
}
