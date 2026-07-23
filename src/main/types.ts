export type Status = 'online' | 'degraded' | 'offline' | 'reboot' | 'unknown' | 'maintenance'
// ~20 популярных валют (нормализация в USD — статичные приблизит. курсы в vault.ts FX).
// ЕДИНЫЙ источник списка валют для всего приложения (дропдауны устройств/подписок, парсер ИИ).
export const CURRENCY_CODES = [
  'USD', 'EUR', 'RUB', 'GBP', 'CNY', 'JPY', 'CHF', 'CAD', 'AUD', 'INR',
  'BRL', 'KRW', 'TRY', 'PLN', 'UAH', 'KZT', 'AED', 'SEK', 'NOK', 'SGD'
] as const
export type Currency = (typeof CURRENCY_CODES)[number]
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
  /** Эфемерная v2-сводка (только renderer-стор): чипы обзора/карточки. rate — байт/с. */
  load1?: number | null
  netRx?: number | null
  netTx?: number | null
  swapUsed?: number | null
  swapTotal?: number | null
  tempCpu?: number | null
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

// ── Богатые live-метрики (AIDA-вкладка). Rate-поля (net/disk) — байт/с из дельты двух сэмплов. ──
export interface GpuInfo {
  util: number
  temp: number
  memUsed: number // GB
  memTotal: number // GB
  power?: number // Вт
}
export interface MountInfo {
  mount: string
  usedPct: number
  usedGb: number
  totalGb: number
}
export interface ProcInfo {
  cmd: string
  cpu: number
  mem: number
}
/** Полный live-снимок для вкладки «Метрики». Optional-поля отсутствуют, если утилиты/датчика нет. */
export interface LiveMetrics {
  cpu: number
  cores: number[]
  load: [number, number, number]
  ramUsed: number // GB
  ramTotal: number // GB
  cacheGb: number
  swapUsed: number // GB
  swapTotal: number // GB
  netRx: number // байт/с
  netTx: number // байт/с
  diskR: number // байт/с
  diskW: number // байт/с
  disk?: number // % корня
  uptime?: number // сек
  tempCpu?: number // °C
  gpu?: GpuInfo
  mounts: MountInfo[]
  top: ProcInfo[]
}

/** Результат операции питания (двухфазный вердикт: принято → проверено).
 *  phase: accepted = команда ушла (для reboot); verified = машина реально погасла/уснула;
 *  rejected = хост отклонил (inhibitor/polkit/нет прав) — error несёт реальный stderr;
 *  still-up = команда ушла, но хост всё ещё отвечает; no-endpoint = не в сети. */
export interface PowerResult {
  ok: boolean
  os: string
  phase: 'accepted' | 'verified' | 'rejected' | 'still-up' | 'no-endpoint'
  output?: string
  error?: string
}

/** Пред-полётная диагностика питания (почему «не выключается»). */
export interface PowerDiag {
  ok: boolean
  os: string
  text: string
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
