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
  Currency,
  DeviceKind,
  DeviceRow,
  DeviceDTO,
  DeviceInput,
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

// Rough static FX just to normalise mixed-currency totals (honest approximation).
const FX: Record<string, number> = { USD: 1, EUR: 1.08, RUB: 0.0126 }
const toUsd = (amount: number, currency: string): number =>
  Math.round(amount * (FX[currency] ?? 1) * 100) / 100

const COLUMNS = [
  'id', 'name', 'provider', 'role', 'kind', 'ip', 'port', 'user', 'country', 'flag', 'os', 'status',
  'cpu', 'ram_used', 'ram_total', 'cost_amount', 'cost_currency', 'cost_usd', 'console_url',
  'auth_type', 'secret_password', 'secret_key', 'secret_passphrase', 'notes', 'jump_id', 'alt', 'sort', 'created_at', 'updated_at'
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
  alt?: { ip: string; user?: string; os?: string }
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
      alt: d.alt?.ip ? JSON.stringify({ ip: d.alt.ip, user: d.alt.user || 'root', os: d.alt.os || '' }) : null,
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
    hasSecret: Boolean(r.secret_password || r.secret_key),
    notes: r.notes,
    jumpId: r.jump_id,
    alt: parseAlt(r.alt)
  }
}

function parseAlt(raw: string | null): DeviceDTO['alt'] {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as { ip?: string; user?: string; os?: string }
    if (!o.ip) return null
    return { ip: o.ip, user: o.user || 'root', os: o.os || '' }
  } catch {
    return null
  }
}

export function listDevices(): DeviceDTO[] {
  const rows = requireDb().prepare('SELECT * FROM devices ORDER BY sort, created_at').all() as DeviceRow[]
  return rows.map(toDTO)
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
    alt: input.alt ? JSON.stringify(input.alt) : null,
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
  // Blank secret on edit = keep the stored one. A newly-pasted key also carries its passphrase.
  const newSecret = input.password ? input.password : cur.secret_password
  const newKey = input.privateKey ? input.privateKey : cur.secret_key
  const newPassphrase = input.privateKey ? input.passphrase ?? null : cur.secret_passphrase
  const authType: AuthType =
    input.authType ?? (input.privateKey ? 'key' : input.password ? 'password' : cur.auth_type)
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
    alt: input.alt !== undefined ? (input.alt ? JSON.stringify(input.alt) : null) : cur.alt,
    updated_at: Date.now()
  }
  d.prepare(
    `UPDATE devices SET
       name=@name, provider=@provider, role=@role, kind=@kind, ip=@ip, port=@port, user=@user,
       country=@country, flag=@flag, os=@os, status=@status, cpu=@cpu,
       ram_used=@ram_used, ram_total=@ram_total, cost_amount=@cost_amount,
       cost_currency=@cost_currency, cost_usd=@cost_usd, console_url=@console_url,
       auth_type=@auth_type, secret_password=@secret_password, secret_key=@secret_key,
       secret_passphrase=@secret_passphrase, notes=@notes, jump_id=@jump_id, alt=@alt, updated_at=@updated_at
     WHERE id=@id`
  ).run(next)
  return toDTO(next)
}

export function deleteDevice(id: string): void {
  requireDb().prepare('DELETE FROM devices WHERE id = ?').run(id)
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

/** OS-строки основной и alt-ОС устройства (для тегирования dual-boot ПК). */
export function getDeviceOsPair(id: string): { os: string; altOs: string } {
  const r = requireDb().prepare('SELECT os, alt FROM devices WHERE id = ?').get(id) as
    | { os: string; alt: string | null }
    | undefined
  let altOs = ''
  if (r?.alt) {
    try {
      altOs = (JSON.parse(r.alt) as { os?: string }).os ?? ''
    } catch {
      /* ignore */
    }
  }
  return { os: r?.os ?? '', altOs }
}

/** Main-process only: conn к альтернативной ОС dual-boot ПК (тот же ключ, alt.ip/alt.user). */
export function getAltConn(id: string): DeviceConn | null {
  const r = requireDb()
    .prepare('SELECT ip, port, user, auth_type, secret_password, secret_key, secret_passphrase, alt FROM devices WHERE id = ?')
    .get(id) as (ConnRow & { alt: string | null }) | undefined
  if (!r || !r.alt) return null
  let alt: { ip?: string; user?: string }
  try {
    alt = JSON.parse(r.alt)
  } catch {
    return null
  }
  if (!alt.ip) return null
  const conn: DeviceConn = {
    host: alt.ip,
    port: r.port || 22,
    user: alt.user || 'root',
    authType: r.auth_type,
    password: r.secret_password
  }
  if (r.auth_type === 'key' && r.secret_key) {
    conn.privateKey = r.secret_key
    conn.passphrase = r.secret_passphrase
  }
  return conn
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

export function deleteWallet(id: string): void {
  requireDb().prepare('DELETE FROM wallets WHERE id = ?').run(id)
}

/** Append a metric sample and keep only the most recent 200 per device. */
export function recordSnapshot(
  deviceId: string,
  m: { cpu?: number; ramUsed?: number; ramTotal?: number; status?: string }
): void {
  const d = requireDb()
  d.prepare(
    'INSERT INTO metric_snapshots (device_id, ts, cpu, ram_used, ram_total, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(deviceId, Date.now(), m.cpu ?? null, m.ramUsed ?? null, m.ramTotal ?? null, m.status ?? 'unknown')
  d.prepare(
    `DELETE FROM metric_snapshots WHERE device_id = ? AND rowid NOT IN
     (SELECT rowid FROM metric_snapshots WHERE device_id = ? ORDER BY ts DESC LIMIT 200)`
  ).run(deviceId, deviceId)
}

export function getSnapshots(deviceId: string, limit = 30): MetricSnapshot[] {
  const rows = requireDb()
    .prepare(
      'SELECT ts, cpu, ram_used as ramUsed, ram_total as ramTotal, status FROM metric_snapshots WHERE device_id = ? ORDER BY ts DESC LIMIT ?'
    )
    .all(deviceId, limit) as MetricSnapshot[]
  return rows.reverse()
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
