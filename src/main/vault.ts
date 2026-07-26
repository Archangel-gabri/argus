import { app } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import { deriveKeyHex } from './crypto'
import { SEED_DEVICES } from './seed'
import type {
  AuthType,
  AltBoot,
  Currency,
  DeviceKind,
  DeviceRow,
  DeviceDTO,
  DeviceInput,
  Status,
  VaultStatus,
  Snippet,
  Subscription,
  SubscriptionInput,
  Wallet,
  WalletInput,
  MetricSnapshot,
  AiAccount,
  AiAccountInput
} from './types'

type Meta = { salt: string; version: number; createdAt: number }

let db: Database.Database | null = null

// Rough static FX just to normalise mixed-currency totals (honest approximation, 2026).
const FX: Record<string, number> = {
  USD: 1, EUR: 1.08, RUB: 0.0126, GBP: 1.27, CNY: 0.14, JPY: 0.0067, CHF: 1.11,
  CAD: 0.73, AUD: 0.66, INR: 0.012, BRL: 0.2, KRW: 0.00075, TRY: 0.03, PLN: 0.25,
  UAH: 0.025, KZT: 0.0021, AED: 0.27, SEK: 0.095, NOK: 0.093, SGD: 0.74
}
const toUsd = (amount: number, currency: string): number =>
  Math.round(amount * (FX[currency] ?? 1) * 100) / 100

const COLUMNS = [
  'id', 'name', 'provider', 'role', 'kind', 'ip', 'port', 'user', 'country', 'flag', 'os', 'status',
  'cpu', 'ram_used', 'ram_total', 'cost_amount', 'cost_currency', 'cost_usd', 'console_url',
  'auth_type', 'secret_password', 'secret_key', 'secret_passphrase', 'notes', 'jump_id', 'alt', 'mac', 'sort', 'created_at', 'updated_at'
] as const
const INSERT_SQL = `INSERT INTO devices (${COLUMNS.join(',')}) VALUES (${COLUMNS.map((c) => '@' + c).join(',')})`

const dbPath = (): string => join(app.getPath('userData'), 'nexus-vault.db')
const metaPath = (): string => join(app.getPath('userData'), 'nexus-vault.meta.json')

export const isInitialized = (): boolean => existsSync(metaPath()) && existsSync(dbPath())
export const isUnlocked = (): boolean => db !== null

export function vaultStatus(): VaultStatus {
  if (isUnlocked()) return 'unlocked'
  return isInitialized() ? 'locked' : 'uninitialized'
}

function openEncrypted(keyHex: string): Database.Database {
  const d = new Database(dbPath())
  d.pragma(`cipher='sqlcipher'`)
  d.pragma(`key="x'${keyHex}'"`)
  d.pragma('journal_mode = WAL')
  d.pragma('foreign_keys = ON')
  return d
}

function migrate(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    role TEXT,
    kind TEXT DEFAULT 'server',
    ip TEXT DEFAULT '',
    port INTEGER DEFAULT 22,
    user TEXT DEFAULT 'root',
    country TEXT DEFAULT '',
    flag TEXT DEFAULT '',
    os TEXT DEFAULT '',
    status TEXT DEFAULT 'online',
    cpu REAL DEFAULT 0,
    ram_used REAL DEFAULT 0,
    ram_total REAL DEFAULT 0,
    cost_amount REAL DEFAULT 0,
    cost_currency TEXT DEFAULT 'USD',
    cost_usd REAL DEFAULT 0,
    console_url TEXT DEFAULT '',
    auth_type TEXT DEFAULT 'none',
    secret_password TEXT,
    secret_key TEXT,
    secret_passphrase TEXT,
    notes TEXT,
    jump_id TEXT,
    alt TEXT,
    mac TEXT,
    sort INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  )`)
  // Add jump_id to pre-existing device tables (fresh tables already have it → ALTER throws, ignored).
  try {
    d.exec('ALTER TABLE devices ADD COLUMN jump_id TEXT')
  } catch {
    /* column already exists */
  }
  // B3: device class for Fleet groups (existing rows are all servers).
  try {
    d.exec(`ALTER TABLE devices ADD COLUMN kind TEXT DEFAULT 'server'`)
  } catch {
    /* column already exists */
  }
  // C: alt OS endpoint for dual-boot PCs.
  try {
    d.exec('ALTER TABLE devices ADD COLUMN alt TEXT')
  } catch {
    /* column already exists */
  }
  // C: MAC for Wake-on-LAN.
  try {
    d.exec('ALTER TABLE devices ADD COLUMN mac TEXT')
  } catch {
    /* column already exists */
  }
  d.exec(`CREATE TABLE IF NOT EXISTS known_hosts (
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    key_hash TEXT NOT NULL,
    first_seen INTEGER,
    PRIMARY KEY (host, port)
  )`)
  d.exec(`CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    created_at INTEGER
  )`)
  // "one object, many facets": cross-domain relations (device↔subscription↔holding↔credential).
  d.exec(`CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT,
    created_at INTEGER
  )`)
  d.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT,
    category TEXT,
    amount REAL,
    currency TEXT,
    period TEXT,
    next_renewal TEXT,
    notes TEXT,
    created_at INTEGER
  )`)
  d.exec(`CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    label TEXT,
    created_at INTEGER
  )`)
  d.exec(`CREATE TABLE IF NOT EXISTS metric_snapshots (
    device_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu REAL,
    ram_used REAL,
    ram_total REAL,
    status TEXT
  )`)
  d.exec('CREATE INDEX IF NOT EXISTS idx_snap_dev ON metric_snapshots (device_id, ts)')
  d.exec(`CREATE TABLE IF NOT EXISTS ai_accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT,
    api_key TEXT,
    plan TEXT,
    notes TEXT,
    created_at INTEGER
  )`)

  // Кэш IP-геолокации (страна/флаг/хостер/ASN) — привязан к IP, а не к устройству. Живёт в
  // зашифрованном vault (IP+инфраструктура приватны). Питает авто-подстановку при добавлении/показе.
  d.exec(`CREATE TABLE IF NOT EXISTS ip_geo (
    ip TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  )`)

  // Кэш сводки комплектующих (железо меняется редко — собираем раз, обновляем по кнопке).
  d.exec(`CREATE TABLE IF NOT EXISTS device_hardware (
    device_id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    collected_at INTEGER NOT NULL
  )`)
}

/** Локальный реальный флот владельца (gitignored `fleet.local.json` рядом с приложением).
 *  keyPath читается с диска в рантайме → secret_key в зашифрованном vault; в код/git ключи
 *  не попадают. Нет файла → возвращаем null и сидим демо-флотом (маскированные IP из seed.ts). */
interface LocalDevice {
  name: string
  provider?: string
  kind?: DeviceKind
  role?: string
  ip?: string
  port?: number
  user?: string
  country?: string
  flag?: string
  os?: string
  consoleUrl?: string
  costAmount?: number
  costCurrency?: Currency
  notes?: string
  keyPath?: string
  mac?: string
  alt?: { ip: string; user?: string; os?: string; bootEntry?: string }
  altOs?: Array<{ ip: string; user?: string; os?: string; bootEntry?: string }>
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p
}

function loadLocalFleet(): DeviceRow[] | null {
  const candidates: string[] = []
  try {
    candidates.push(join(app.getAppPath(), 'fleet.local.json'))
  } catch {
    /* app path unavailable */
  }
  candidates.push(join(process.cwd(), 'fleet.local.json'))
  const path = candidates.find((p) => existsSync(p))
  if (!path) return null
  let list: LocalDevice[]
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { devices?: LocalDevice[] }
    list = json.devices ?? []
  } catch {
    return null
  }
  if (list.length === 0) return null
  const now = Date.now()
  return list.map((d, i): DeviceRow => {
    let secretKey: string | null = null
    let authType: AuthType = 'none'
    if (d.keyPath) {
      try {
        secretKey = readFileSync(expandHome(d.keyPath), 'utf8')
        authType = 'key'
      } catch {
        /* ключ на диске недоступен → авторизацию введёт владелец в приложении */
      }
    }
    const amount = d.costAmount ?? 0
    const currency = (d.costCurrency ?? 'USD') as Currency
    return {
      id: randomUUID(),
      name: d.name,
      provider: d.provider || 'Custom',
      role: d.role ?? null,
      kind: d.kind ?? 'server',
      ip: d.ip ?? '',
      port: d.port ?? 22,
      user: d.user || 'root',
      country: d.country ?? '',
      flag: d.flag || '🖥️',
      os: d.os ?? '',
      status: 'unknown',
      cpu: 0,
      ram_used: 0,
      ram_total: 0,
      cost_amount: amount,
      cost_currency: currency,
      cost_usd: toUsd(amount, currency),
      console_url: d.consoleUrl ?? '',
      auth_type: authType,
      secret_password: null,
      secret_key: secretKey,
      secret_passphrase: null,
      notes: d.notes ?? null,
      jump_id: null,
      alt: (() => {
        const list = d.altOs ?? (d.alt ? [d.alt] : [])
        const clean = list.filter((a) => a && a.ip).map((a) => ({ ip: a.ip, user: a.user || 'root', os: a.os || '', bootEntry: a.bootEntry }))
        return clean.length ? JSON.stringify(clean) : null
      })(),
      mac: d.mac || null,
      sort: i,
      created_at: now,
      updated_at: now
    }
  })
}

function seedInto(d: Database.Database): void {
  const now = Date.now()
  const stmt = d.prepare(INSERT_SQL)
  const insertAll = d.transaction((rows: DeviceRow[]) => {
    for (const r of rows) stmt.run(r)
  })
  const local = loadLocalFleet()
  const rows =
    local ??
    SEED_DEVICES.map(
      (s, i): DeviceRow => ({
        ...s,
        kind: 'server',
        auth_type: 'none',
        secret_password: null,
        secret_key: null,
        secret_passphrase: null,
        notes: null,
        jump_id: null,
        alt: null,
        mac: null,
        sort: i,
        created_at: now,
        updated_at: now
      })
    )
  insertAll(rows)
}

export async function initialize(password: string): Promise<void> {
  if (isInitialized()) throw new Error('Vault already initialized')
  if (!password || password.length < 6) throw new Error('Master password must be at least 6 characters')
  const salt = randomBytes(16)
  const keyHex = await deriveKeyHex(password, salt)
  const d = openEncrypted(keyHex)
  migrate(d)
  seedInto(d)
  const meta: Meta = { salt: salt.toString('hex'), version: 1, createdAt: Date.now() }
  writeFileSync(metaPath(), JSON.stringify(meta), { mode: 0o600 })
  db = d
}

export async function unlock(password: string): Promise<void> {
  if (!isInitialized()) throw new Error('Vault not initialized')
  if (isUnlocked()) return
  const newMetaPath = metaPath() + '.new'

  // Кандидаты соли: текущая meta + (если есть) незавершённый rekey (.new).
  // Это реконсиляция changePassword: rekey мог пройти, а публикация соли (rename) — нет.
  const meta = JSON.parse(readFileSync(metaPath(), 'utf8')) as Meta
  const candidates: Array<{ salt: string; fromNew: boolean }> = [{ salt: meta.salt, fromNew: false }]
  if (existsSync(newMetaPath)) {
    try {
      const nm = JSON.parse(readFileSync(newMetaPath, 'utf8')) as Meta
      candidates.push({ salt: nm.salt, fromNew: true })
    } catch {
      /* повреждённый .new — игнорируем */
    }
  }

  for (const cand of candidates) {
    const keyHex = await deriveKeyHex(password, Buffer.from(cand.salt, 'hex'))
    const d = openEncrypted(keyHex)
    try {
      // Force key verification: a wrong key makes the first read throw.
      d.prepare('SELECT count(*) AS n FROM sqlite_master').get()
      migrate(d) // idempotent — keeps schema current
      db = d
      if (cand.fromNew) {
        // rekey прошёл, rename — нет: финализируем публикацию новой соли.
        renameSync(newMetaPath, metaPath())
      } else if (existsSync(newMetaPath)) {
        // Текущая соль сработала → .new устарел (rekey не состоялся). Убираем.
        try {
          unlinkSync(newMetaPath)
        } catch {
          /* ignore */
        }
      }
      return
    } catch {
      try {
        d.close()
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error('Invalid master password')
}

export function lock(): void {
  if (db) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}

/** Смена мастер-пароля. Crash-safe two-phase commit:
 *  1) новая соль пишется в meta.json.new ДО rekey;
 *  2) соединение уводится из WAL в rollback-journal, rekey идёт транзакционно;
 *  3) новая соль публикуется атомарным rename.
 *  Реконсиляция при обрыве — в unlock(): пробует текущую соль, затем .new, и финализирует
 *  rename если ключ .new подошёл (rekey прошёл, публикация — нет). Ни одна комбинация
 *  «rekey прошёл / rename упал / краш между ними» больше не окирпичивает vault. */
export async function changePassword(current: string, next: string): Promise<void> {
  if (!isInitialized()) throw new Error('Vault not initialized')
  if (!next || next.length < 6) throw new Error('Новый пароль — минимум 6 символов')
  const meta = JSON.parse(readFileSync(metaPath(), 'utf8')) as Meta
  const curKey = await deriveKeyHex(current, Buffer.from(meta.salt, 'hex'))
  // Проверяем текущий пароль отдельным подключением (не трогаем живое db).
  const probe = new Database(dbPath())
  try {
    probe.pragma(`cipher='sqlcipher'`)
    probe.pragma(`key="x'${curKey}'"`)
    probe.prepare('SELECT count(*) AS n FROM sqlite_master').get()
  } catch {
    try {
      probe.close()
    } catch {
      /* ignore */
    }
    throw new Error('Неверный текущий пароль')
  }
  probe.close()

  const salt = randomBytes(16)
  const newKey = await deriveKeyHex(next, salt)
  const nextMeta: Meta = { ...meta, salt: salt.toString('hex') }
  const newMetaPath = metaPath() + '.new'
  // (1) новая соль на диск ДО rekey. rekey прошёл + rename упал → unlock финализирует по .new;
  //     rekey упал → .new устарел и будет удалён при следующем unlock со старой солью.
  writeFileSync(newMetaPath, JSON.stringify(nextMeta), { mode: 0o600 })

  const d = db ?? openEncrypted(curKey)
  // (2) уводим из WAL, чтобы rekey шёл через rollback-journal, а не сложился в WAL-кадры
  //     под несогласованными ключами (иначе обрыв даёт «file is not a database»).
  d.pragma('wal_checkpoint(TRUNCATE)')
  d.pragma('journal_mode = DELETE')
  try {
    d.pragma(`rekey="x'${newKey}'"`)
  } finally {
    d.pragma('journal_mode = WAL')
  }
  // (3) публикуем новую соль атомарным rename.
  renameSync(newMetaPath, metaPath())
  if (db) db = d
  else d.close()
}

function requireDb(): Database.Database {
  if (!db) throw new Error('Vault is locked')
  return db
}

function toDTO(r: DeviceRow): DeviceDTO {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    role: r.role,
    kind: r.kind ?? 'server',
    ip: r.ip,
    port: r.port,
    user: r.user,
    country: r.country,
    flag: r.flag,
    os: r.os,
    status: r.status,
    cpu: r.cpu,
    ram: { used: r.ram_used, total: r.ram_total },
    cost: { amount: r.cost_amount, currency: r.cost_currency, usd: r.cost_usd },
    consoleUrl: r.console_url,
    authType: r.auth_type,
    // hasSecret считаем по ВЫБРАННОМУ методу — иначе устаревший ключ у password-устройства
    // (или наоборот) заставлял бы UI показывать «доступ есть», хотя коннект невозможен.
    hasSecret: r.auth_type === 'key' ? Boolean(r.secret_key) : r.auth_type === 'password' ? Boolean(r.secret_password) : false,
    notes: r.notes,
    jumpId: r.jump_id,
    altOs: parseAltOs(r.alt),
    mac: r.mac
  }
}

/** JSON колонки alt → список AltBoot. Обратная совместимость: одиночный объект → [объект]. */
function parseAltOs(raw: string | null): AltBoot[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    const arr = Array.isArray(v) ? v : [v]
    return arr
      .map((o) => o as { ip?: string; user?: string; os?: string; bootEntry?: string })
      .filter((o) => o && o.ip)
      .map((o) => ({ ip: o.ip as string, user: o.user || 'root', os: o.os || '', bootEntry: o.bootEntry }))
  } catch {
    return []
  }
}

/** Последний снапшот по каждому устройству — одним запросом (для мгновенной отрисовки). */
function latestStates(): Map<string, { ts: number; cpu: number | null; ramUsed: number | null; ramTotal: number | null; status: string }> {
  const rows = requireDb()
    .prepare(
      `SELECT s.device_id AS id, s.ts, s.cpu, s.ram_used AS ramUsed, s.ram_total AS ramTotal, s.status
         FROM metric_snapshots s
         JOIN (SELECT device_id, MAX(ts) AS mts FROM metric_snapshots GROUP BY device_id) m
           ON m.device_id = s.device_id AND m.mts = s.ts`
    )
    .all() as Array<{ id: string; ts: number; cpu: number | null; ramUsed: number | null; ramTotal: number | null; status: string }>
  return new Map(rows.map((r) => [r.id, r]))
}

// Снапшоты ПК пишутся со status = семейство ОС ('windows'/'linux'/'off'), а не Status.
const snapStatus = (s: string): Status | null =>
  s === 'off' ? 'offline' : s === 'windows' || s === 'linux' ? 'online' : (s as Status) || null

/** Устройства + ПОСЛЕДНЕЕ ИЗВЕСТНОЕ состояние из снапшотов. Без этого после входа рисовалась
 *  пустая сетка («0 online», нули) до конца первого опроса — по замеру это 70 секунд. */
export function listDevices(): DeviceDTO[] {
  const rows = requireDb().prepare('SELECT * FROM devices ORDER BY sort, created_at').all() as DeviceRow[]
  const states = latestStates()
  return rows.map((r) => {
    const dto = toDTO(r)
    const s = states.get(r.id)
    if (!s) return dto
    return {
      ...dto,
      status: snapStatus(s.status) ?? dto.status,
      cpu: s.cpu ?? dto.cpu,
      ram: { used: s.ramUsed ?? dto.ram.used, total: s.ramTotal ?? dto.ram.total },
      lastSeen: s.ts
    }
  })
}

export function createDevice(input: DeviceInput): DeviceDTO {
  const d = requireDb()
  const now = Date.now()
  const nextSort = (d.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM devices').get() as { s: number }).s
  const cost = input.cost ?? { amount: 0, currency: 'USD' as const, usd: 0 }
  const row: DeviceRow = {
    id: randomUUID(),
    name: input.name.trim(),
    provider: input.provider.trim() || 'Custom',
    role: input.role ?? null,
    kind: input.kind ?? 'server',
    ip: input.ip ?? '',
    port: input.port ?? 22,
    user: input.user || 'root',
    country: input.country ?? '',
    flag: input.flag || '🖥️',
    os: input.os ?? '',
    status: input.status ?? 'online',
    cpu: input.cpu ?? 0,
    ram_used: input.ram?.used ?? 0,
    ram_total: input.ram?.total ?? 0,
    cost_amount: cost.amount ?? 0,
    cost_currency: cost.currency ?? 'USD',
    cost_usd: cost.usd || toUsd(cost.amount ?? 0, cost.currency ?? 'USD'),
    console_url: input.consoleUrl ?? '',
    auth_type: input.authType ?? (input.privateKey ? 'key' : input.password ? 'password' : 'none'),
    secret_password: input.password || null,
    secret_key: input.privateKey || null,
    secret_passphrase: input.passphrase || null,
    notes: input.notes ?? null,
    jump_id: input.jumpId ?? null,
    alt: input.altOs && input.altOs.length ? JSON.stringify(input.altOs) : null,
    mac: input.mac || null,
    sort: nextSort,
    created_at: now,
    updated_at: now
  }
  d.prepare(INSERT_SQL).run(row)
  return toDTO(row)
}

export function updateDevice(id: string, input: DeviceInput): DeviceDTO {
  const d = requireDb()
  const cur = d.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined
  if (!cur) throw new Error('Device not found')
  const cost = input.cost ?? { amount: cur.cost_amount, currency: cur.cost_currency, usd: cur.cost_usd }
  const authType: AuthType =
    input.authType ?? (input.privateKey ? 'key' : input.password ? 'password' : cur.auth_type)
  // Секреты по ВЫБРАННОМУ методу: пустое поле на правке = оставить текущий секрет ЭТОГО метода,
  // но секрет НЕ выбранного метода ОБНУЛЯЕМ — иначе смена key↔password оставляла висящий ключ/пароль,
  // и getDeviceConn мог молча ходить со старым секретом, а hasSecret врал.
  let newSecret: string | null
  let newKey: string | null
  let newPassphrase: string | null
  if (authType === 'key') {
    newKey = input.privateKey ? input.privateKey : cur.secret_key
    newPassphrase = input.privateKey ? input.passphrase ?? null : cur.secret_passphrase
    newSecret = null
  } else if (authType === 'password') {
    newSecret = input.password ? input.password : cur.secret_password
    newKey = null
    newPassphrase = null
  } else {
    newSecret = null
    newKey = null
    newPassphrase = null
  }
  const next: DeviceRow = {
    ...cur,
    name: input.name?.trim() || cur.name,
    provider: input.provider?.trim() || cur.provider,
    role: input.role ?? cur.role,
    kind: input.kind ?? cur.kind ?? 'server',
    ip: input.ip ?? cur.ip,
    port: input.port ?? cur.port,
    user: input.user ?? cur.user,
    country: input.country ?? cur.country,
    flag: input.flag ?? cur.flag,
    os: input.os ?? cur.os,
    status: input.status ?? cur.status,
    cpu: input.cpu ?? cur.cpu,
    ram_used: input.ram?.used ?? cur.ram_used,
    ram_total: input.ram?.total ?? cur.ram_total,
    cost_amount: cost.amount,
    cost_currency: cost.currency,
    cost_usd: cost.usd || toUsd(cost.amount, cost.currency),
    console_url: input.consoleUrl ?? cur.console_url,
    auth_type: authType,
    secret_password: newSecret,
    secret_key: newKey,
    secret_passphrase: newPassphrase,
    notes: input.notes ?? cur.notes,
    jump_id: input.jumpId !== undefined ? input.jumpId : cur.jump_id,
    alt: input.altOs !== undefined ? (input.altOs.length ? JSON.stringify(input.altOs) : null) : cur.alt,
    mac: input.mac !== undefined ? input.mac || null : cur.mac,
    updated_at: Date.now()
  }
  d.prepare(
    `UPDATE devices SET
       name=@name, provider=@provider, role=@role, kind=@kind, ip=@ip, port=@port, user=@user,
       country=@country, flag=@flag, os=@os, status=@status, cpu=@cpu,
       ram_used=@ram_used, ram_total=@ram_total, cost_amount=@cost_amount,
       cost_currency=@cost_currency, cost_usd=@cost_usd, console_url=@console_url,
       auth_type=@auth_type, secret_password=@secret_password, secret_key=@secret_key,
       secret_passphrase=@secret_passphrase, notes=@notes, jump_id=@jump_id, alt=@alt, mac=@mac, updated_at=@updated_at
     WHERE id=@id`
  ).run(next)
  return toDTO(next)
}

/** Удаление устройства — транзакцией, с зачисткой зависимостей (иначе оставались сироты-снапшоты
 *  и битые jump-ссылки у других устройств). Возвращает true, если строка реально удалена. */
export function deleteDevice(id: string): boolean {
  const d = requireDb()
  const tx = d.transaction((deviceId: string): boolean => {
    d.prepare('DELETE FROM metric_snapshots WHERE device_id = ?').run(deviceId)
    d.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(deviceId, deviceId)
    // Устройства, для которых удаляемый был бастионом, теряют jump — иначе висячий jump_id
    // ломает им подключение.
    d.prepare('UPDATE devices SET jump_id = NULL WHERE jump_id = ?').run(deviceId)
    return d.prepare('DELETE FROM devices WHERE id = ?').run(deviceId).changes > 0
  })
  return tx(id)
}

export interface JumpConn {
  host: string
  port: number
  user: string
  password: string | null
  privateKey?: string | null
  passphrase?: string | null
}

export interface DeviceConn {
  host: string
  port: number
  user: string
  authType: AuthType
  password: string | null
  privateKey?: string | null
  passphrase?: string | null
  jump?: JumpConn
}

type ConnRow = {
  ip: string
  port: number
  user: string
  auth_type: AuthType
  secret_password: string | null
  secret_key: string | null
  secret_passphrase: string | null
  jump_id?: string | null
}

/** Main-process only: connection info + decrypted secret for SSH (+ single-hop jump). Never exposed to renderer. */
export function getDeviceConn(id: string): DeviceConn | null {
  const r = requireDb()
    .prepare('SELECT ip, port, user, auth_type, secret_password, secret_key, secret_passphrase, jump_id FROM devices WHERE id = ?')
    .get(id) as ConnRow | undefined
  if (!r) return null
  const conn: DeviceConn = {
    host: r.ip,
    port: r.port || 22,
    user: r.user || 'root',
    authType: r.auth_type,
    password: r.secret_password
  }
  // Key auth wins only when the device is configured for it AND a key is stored.
  if (r.auth_type === 'key' && r.secret_key) {
    conn.privateKey = r.secret_key
    conn.passphrase = r.secret_passphrase
  }
  if (r.jump_id) {
    const j = requireDb()
      .prepare('SELECT ip, port, user, auth_type, secret_password, secret_key, secret_passphrase FROM devices WHERE id = ?')
      .get(r.jump_id) as ConnRow | undefined
    if (j && j.ip && !j.ip.includes('x.x')) {
      conn.jump = { host: j.ip, port: j.port || 22, user: j.user || 'root', password: j.secret_password }
      if (j.auth_type === 'key' && j.secret_key) {
        conn.jump.privateKey = j.secret_key
        conn.jump.passphrase = j.secret_passphrase
      }
    }
  }
  return conn
}

/** MAC устройства для Wake-on-LAN (main-only). */
export function getDeviceMac(id: string): string | null {
  const r = requireDb().prepare('SELECT mac FROM devices WHERE id = ?').get(id) as { mac: string | null } | undefined
  return r?.mac ?? null
}

export interface OsEndpoint {
  os: string
  bootEntry?: string
  conn: DeviceConn
}

/** Main-process only: все ОС-эндпоинты multi-boot ПК (основной + доп.), с conn на каждом
 *  (тот же ключ). Primary = device.ip/os; далее — каждый altOs. Для whichOs/metrics/boot. */
export function getOsEndpoints(id: string): OsEndpoint[] {
  const r = requireDb()
    .prepare('SELECT ip, port, user, os, auth_type, secret_password, secret_key, secret_passphrase, alt FROM devices WHERE id = ?')
    .get(id) as (ConnRow & { os: string; alt: string | null }) | undefined
  if (!r) return []
  const mkConn = (host: string, user: string): DeviceConn => {
    const c: DeviceConn = {
      host,
      port: r.port || 22,
      user: user || 'root',
      authType: r.auth_type,
      password: r.secret_password
    }
    if (r.auth_type === 'key' && r.secret_key) {
      c.privateKey = r.secret_key
      c.passphrase = r.secret_passphrase
    }
    return c
  }
  const out: OsEndpoint[] = []
  if (r.ip && !r.ip.includes('x.x')) out.push({ os: r.os || '', conn: mkConn(r.ip, r.user) })
  const alts = parseAltOs(r.alt)
  for (const a of alts) out.push({ os: a.os, bootEntry: a.bootEntry, conn: mkConn(a.ip, a.user) })
  return out
}

/** TOFU host-key check: 'new' (just stored), 'match', or 'changed'. Main-process only. */
export function checkHostKey(host: string, port: number, keyHash: string): 'new' | 'match' | 'changed' {
  const d = requireDb()
  const row = d.prepare('SELECT key_hash FROM known_hosts WHERE host = ? AND port = ?').get(host, port) as
    | { key_hash: string }
    | undefined
  if (!row) {
    d.prepare('INSERT INTO known_hosts (host, port, key_hash, first_seen) VALUES (?, ?, ?, ?)').run(
      host,
      port,
      keyHash,
      Date.now()
    )
    return 'new'
  }
  return row.key_hash === keyHash ? 'match' : 'changed'
}

/** Forget a saved host key so the next connect re-pins it (for the "trust new key" action). */
export function forgetHostKey(host: string, port: number): void {
  requireDb().prepare('DELETE FROM known_hosts WHERE host = ? AND port = ?').run(host, port)
}

export function listSnippets(): Snippet[] {
  return requireDb().prepare('SELECT id, name, command FROM snippets ORDER BY name').all() as Snippet[]
}

export function createSnippet(name: string, command: string): Snippet {
  const id = randomUUID()
  requireDb()
    .prepare('INSERT INTO snippets (id, name, command, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name.trim() || 'snippet', command, Date.now())
  return { id, name: name.trim() || 'snippet', command }
}

export function deleteSnippet(id: string): void {
  requireDb().prepare('DELETE FROM snippets WHERE id = ?').run(id)
}

export function listSubscriptions(): Subscription[] {
  return requireDb()
    .prepare(
      'SELECT id, name, provider, category, amount, currency, period, next_renewal as nextRenewal, notes FROM subscriptions ORDER BY name'
    )
    .all() as Subscription[]
}

export function createSubscription(input: SubscriptionInput): Subscription {
  const sub: Subscription = {
    id: randomUUID(),
    name: input.name.trim() || 'Подписка',
    provider: input.provider ?? '',
    category: input.category ?? 'Прочее',
    amount: input.amount || 0,
    currency: input.currency ?? 'USD',
    period: input.period ?? 'mo',
    nextRenewal: input.nextRenewal ?? null,
    notes: input.notes ?? null
  }
  requireDb()
    .prepare(
      `INSERT INTO subscriptions (id, name, provider, category, amount, currency, period, next_renewal, notes, created_at)
       VALUES (@id, @name, @provider, @category, @amount, @currency, @period, @nextRenewal, @notes, @created_at)`
    )
    .run({ ...sub, created_at: Date.now() })
  return sub
}

export function updateSubscription(id: string, input: SubscriptionInput): Subscription {
  const cur = listSubscriptions().find((s) => s.id === id)
  if (!cur) throw new Error('Subscription not found')
  const sub: Subscription = {
    id,
    name: input.name?.trim() || cur.name,
    provider: input.provider ?? cur.provider,
    category: input.category ?? cur.category,
    amount: input.amount ?? cur.amount,
    currency: input.currency ?? cur.currency,
    period: input.period ?? cur.period,
    nextRenewal: input.nextRenewal !== undefined ? input.nextRenewal : cur.nextRenewal,
    notes: input.notes !== undefined ? input.notes : cur.notes
  }
  requireDb()
    .prepare(
      `UPDATE subscriptions SET name=@name, provider=@provider, category=@category, amount=@amount,
       currency=@currency, period=@period, next_renewal=@nextRenewal, notes=@notes WHERE id=@id`
    )
    .run(sub)
  return sub
}

export function deleteSubscription(id: string): void {
  requireDb().prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
}

export function listWallets(): Wallet[] {
  return requireDb().prepare('SELECT id, chain, address, label FROM wallets ORDER BY created_at').all() as Wallet[]
}

export function createWallet(input: WalletInput): Wallet {
  const wallet: Wallet = {
    id: randomUUID(),
    chain: (input.chain || 'ETH').toUpperCase(),
    address: input.address.trim(),
    label: input.label?.trim() || input.chain.toUpperCase()
  }
  requireDb()
    .prepare('INSERT INTO wallets (id, chain, address, label, created_at) VALUES (@id, @chain, @address, @label, @created_at)')
    .run({ ...wallet, created_at: Date.now() })
  return wallet
}

export function updateWallet(id: string, input: WalletInput): Wallet {
  const cur = listWallets().find((w) => w.id === id)
  if (!cur) throw new Error('Wallet not found')
  const wallet: Wallet = {
    id,
    chain: (input.chain || cur.chain).toUpperCase(),
    address: input.address?.trim() || cur.address,
    label: input.label?.trim() || cur.label
  }
  requireDb().prepare('UPDATE wallets SET chain=@chain, address=@address, label=@label WHERE id=@id').run(wallet)
  return wallet
}

export function deleteWallet(id: string): void {
  requireDb().prepare('DELETE FROM wallets WHERE id = ?').run(id)
}

// Хранение истории метрик: до 5000 точек ИЛИ последние 60 дней на устройство (что раньше).
const SNAP_KEEP = 5000
const SNAP_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

/** Append a metric sample; обрезаем по возрасту (60 дней) и числу (5000) на устройство. */
export function recordSnapshot(
  deviceId: string,
  m: { cpu?: number; ramUsed?: number; ramTotal?: number; status?: string }
): void {
  const d = requireDb()
  d.prepare(
    'INSERT INTO metric_snapshots (device_id, ts, cpu, ram_used, ram_total, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(deviceId, Date.now(), m.cpu ?? null, m.ramUsed ?? null, m.ramTotal ?? null, m.status ?? 'unknown')
  d.prepare('DELETE FROM metric_snapshots WHERE device_id = ? AND ts < ?').run(deviceId, Date.now() - SNAP_MAX_AGE_MS)
  d.prepare(
    `DELETE FROM metric_snapshots WHERE device_id = ? AND rowid NOT IN
     (SELECT rowid FROM metric_snapshots WHERE device_id = ? ORDER BY ts DESC LIMIT ?)`
  ).run(deviceId, deviceId, SNAP_KEEP)
}

export function getSnapshots(deviceId: string, limit = 30): MetricSnapshot[] {
  const rows = requireDb()
    .prepare(
      'SELECT ts, cpu, ram_used as ramUsed, ram_total as ramTotal, status FROM metric_snapshots WHERE device_id = ? ORDER BY ts DESC LIMIT ?'
    )
    .all(deviceId, limit) as MetricSnapshot[]
  return rows.reverse()
}

// ── IP-геолокация: кэш + авто-подстановка страны/флага/хостера ────────────────────────
const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 дней

/** Гео из кэша, если не старше TTL (иначе null → нужен свежий запрос). */
export function getIpGeo(ip: string): Record<string, unknown> | null {
  if (!isUnlocked()) return null
  const row = requireDb().prepare('SELECT json, checked_at FROM ip_geo WHERE ip = ?').get(ip) as
    | { json: string; checked_at: number }
    | undefined
  if (!row || Date.now() - row.checked_at > GEO_TTL_MS) return null
  try {
    return JSON.parse(row.json) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Записать гео IP в кэш (upsert). */
export function setIpGeo(ip: string, data: Record<string, unknown>): void {
  if (!isUnlocked()) return
  requireDb()
    .prepare(
      `INSERT INTO ip_geo (ip, json, checked_at) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET json=excluded.json, checked_at=excluded.checked_at`
    )
    .run(ip, JSON.stringify(data), Date.now())
}

/** Заполнить ПУСТЫЕ country/flag/provider устройства из гео. Введённое руками не трогаем
 *  (реселлеры: провайдер владельца важнее ASN-владельца). Возвращает обновлённый DTO или null. */
export function applyGeoToDevice(
  id: string,
  geo: { country?: string; flag?: string; provider?: string }
): DeviceDTO | null {
  if (!isUnlocked()) return null
  const d = requireDb()
  const cur = d.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined
  if (!cur) return null
  const hasCountry = Boolean(cur.country?.trim())
  const hasFlag = Boolean(cur.flag && cur.flag !== '🖥️')
  const hasProvider = Boolean(cur.provider && !['Custom', 'SSH', ''].includes(cur.provider))
  const country = hasCountry ? cur.country : geo.country?.trim() || cur.country
  const flag = hasFlag ? cur.flag : geo.flag || cur.flag
  const provider = hasProvider ? cur.provider : geo.provider?.trim() || cur.provider
  if (country === cur.country && flag === cur.flag && provider === cur.provider) return null
  d.prepare('UPDATE devices SET country=?, flag=?, provider=?, updated_at=? WHERE id=?').run(
    country,
    flag,
    provider,
    Date.now(),
    id
  )
  return toDTO({ ...cur, country, flag, provider })
}

/** Кэш сводки железа устройства (или null). */
export function getDeviceHardware(id: string): { info: Record<string, unknown>; collectedAt: number } | null {
  if (!isUnlocked()) return null
  const row = requireDb().prepare('SELECT json, collected_at FROM device_hardware WHERE device_id = ?').get(id) as
    | { json: string; collected_at: number }
    | undefined
  if (!row) return null
  try {
    return { info: JSON.parse(row.json) as Record<string, unknown>, collectedAt: row.collected_at }
  } catch {
    return null
  }
}

/** Записать сводку железа (upsert). */
export function setDeviceHardware(id: string, info: Record<string, unknown>): void {
  if (!isUnlocked()) return
  requireDb()
    .prepare(
      `INSERT INTO device_hardware (device_id, json, collected_at) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET json=excluded.json, collected_at=excluded.collected_at`
    )
    .run(id, JSON.stringify(info), Date.now())
}

// AI accounts — api_key lives in the SQLCipher DB; the DTO exposes only hasKey (never the key).
export function listAiAccounts(): AiAccount[] {
  const rows = requireDb()
    .prepare('SELECT id, provider, label, api_key, plan, notes FROM ai_accounts ORDER BY created_at')
    .all() as Array<{ id: string; provider: string; label: string; api_key: string | null; plan: string | null; notes: string | null }>
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label || r.provider,
    plan: r.plan || '',
    hasKey: Boolean(r.api_key),
    notes: r.notes
  }))
}

export function createAiAccount(input: AiAccountInput): AiAccount {
  const id = randomUUID()
  requireDb()
    .prepare('INSERT INTO ai_accounts (id, provider, label, api_key, plan, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.provider, input.label?.trim() || input.provider, input.apiKey || null, input.plan ?? '', input.notes ?? null, Date.now())
  return {
    id,
    provider: input.provider,
    label: input.label?.trim() || input.provider,
    plan: input.plan ?? '',
    hasKey: Boolean(input.apiKey),
    notes: input.notes ?? null
  }
}

export function updateAiAccount(id: string, input: AiAccountInput): AiAccount {
  const d = requireDb()
  const cur = d
    .prepare('SELECT id, provider, label, api_key, plan, notes FROM ai_accounts WHERE id = ?')
    .get(id) as { provider: string; label: string; api_key: string | null; plan: string | null; notes: string | null } | undefined
  if (!cur) throw new Error('AI account not found')
  // Пустой apiKey на правке = оставить текущий ключ (частый случай — правим только метку/план).
  const api_key = input.apiKey ? input.apiKey : cur.api_key
  const next = {
    id,
    provider: input.provider ?? cur.provider,
    label: input.label?.trim() || cur.label || (input.provider ?? cur.provider),
    api_key,
    plan: input.plan ?? cur.plan ?? '',
    notes: input.notes !== undefined ? input.notes : cur.notes
  }
  d.prepare('UPDATE ai_accounts SET provider=@provider, label=@label, api_key=@api_key, plan=@plan, notes=@notes WHERE id=@id').run(next)
  return { id, provider: next.provider, label: next.label, plan: next.plan ?? '', hasKey: Boolean(next.api_key), notes: next.notes }
}

export function deleteAiAccount(id: string): void {
  requireDb().prepare('DELETE FROM ai_accounts WHERE id = ?').run(id)
}

/** Main-process only: decrypt the stored key for a validity/quota probe. Never exposed to the renderer. */
export function getAiKey(id: string): string | null {
  const r = requireDb().prepare('SELECT api_key FROM ai_accounts WHERE id = ?').get(id) as { api_key: string | null } | undefined
  return r?.api_key ?? null
}

// Cross-domain links (foundation for "one object, many facets"). Populated as tabs move mock→DB.
export interface Link {
  id: string
  from_id: string
  to_id: string
  kind: string | null
}

export function createLink(fromId: string, toId: string, kind: string): Link {
  const id = randomUUID()
  requireDb()
    .prepare('INSERT INTO links (id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, fromId, toId, kind, Date.now())
  return { id, from_id: fromId, to_id: toId, kind }
}

export function listLinks(entityId: string): Link[] {
  return requireDb()
    .prepare('SELECT id, from_id, to_id, kind FROM links WHERE from_id = ? OR to_id = ?')
    .all(entityId, entityId) as Link[]
}

export function deleteLink(id: string): void {
  requireDb().prepare('DELETE FROM links WHERE id = ?').run(id)
}
