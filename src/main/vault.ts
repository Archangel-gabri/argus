import { app } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import { deriveKeyHex } from './crypto'
import { prepareVaultInitialization, type VaultMeta } from './vault-init'
import { addColumn } from './migrate-guard'
import { beginAccess, isAccessCurrent, revokePendingAccess } from './access-epoch'
import {
  METRIC_SNAPSHOT_INSERT,
  snapshotStatus,
  snapshotValues,
  type SnapshotInput
} from './metric-snapshot'
import { initialStatus } from '../shared/reachability'
import {
  legacyManualRenewal,
  parseDeviceCost,
  parseSubscriptionInput,
  parseWalletInput,
  text
} from './finance-validation'
import type {
  AuthType,
  AltBoot,
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
  AiAccess,
  AiAccessInput,
  AiAccountEntry,
  AiChannel,
  AiAccessModel,
  AiKind,
  AiLimits,
  AiPayment,
  AiPrice,
  AiStatus,
  AiUsageBlock,
  AiUsageDay
} from './types'

type Meta = VaultMeta

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
  'auth_type', 'secret_password', 'secret_key', 'secret_passphrase', 'notes', 'jump_id', 'alt', 'mac', 'icon', 'boot_entry', 'sort', 'created_at', 'updated_at'
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

/**
 * Открыть зашифрованную базу.
 *
 * Соединение закрывается ЗДЕСЬ, если настройка не удалась. Это не перестраховка: неверный
 * ключ обнаруживается на `journal_mode` — то есть уже ПОСЛЕ того, как `new Database()` завёл
 * дескриптор файла. Пока бросок происходил из середины функции, значение наружу не
 * возвращалось, и закрывать вызывающему было нечего: handle просто терялся.
 *
 * Измерено: тридцать неверных паролей подряд — тридцать утёкших дескрипторов. На автолоке с
 * ошибочным вводом или на переборе это упирается в лимит открытых файлов, после чего начинают
 * падать SSH, диалоги и сам vault — с ошибками, никак не похожими на причину.
 */
function openEncrypted(keyHex: string): Database.Database {
  const d = new Database(dbPath())
  try {
    d.pragma(`cipher='sqlcipher'`)
    d.pragma(`key="x'${keyHex}'"`)
    d.pragma('journal_mode = WAL')
    d.pragma('foreign_keys = ON')
    return d
  } catch (e) {
    try {
      d.close()
    } catch {
      /* уже закрыт — важно лишь то, что дескриптор не остался висеть */
    }
    throw e
  }
}

function migrate(d: Database.Database): void {
  // Наращивание схемы идёт через addColumn: он терпит ТОЛЬКО «колонка уже есть». Раньше здесь
  // стояли одиннадцать голых `catch {}`, и под тем же кодом SQLITE_ERROR молча проглатывались
  // повреждение базы, отсутствие таблицы и кончившийся диск — приложение продолжало работать
  // на схеме, которой нет, а всплывало это позже и в другом месте.
  const exec = (sql: string): void => {
    d.exec(sql)
  }

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
    status TEXT DEFAULT 'unknown',
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
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN jump_id TEXT')
  // B3: device class for Fleet groups (existing rows are all servers).
  addColumn(exec, `ALTER TABLE devices ADD COLUMN kind TEXT DEFAULT 'server'`)
  // C: alt OS endpoint for dual-boot PCs.
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN alt TEXT')
  // Экран: пароль учётки ОС для трансляции (RDP/NLA) — отдельный секрет, не SSH.
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN screen_password TEXT')
  // Токен собственного агента трансляции (выдаётся при провижининге по SSH).
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN agent_token TEXT')
  // Закреплённый отпечаток TLS-сертификата агента (TOFU, как host-key у SSH).
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN agent_cert TEXT')
  // Загрузочная запись ОСНОВНОЙ ОС (EFI-идентификатор или пункт меню загрузчика).
  // Без неё переключение ОС из Windows не могло указать цель.
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN boot_entry TEXT')
  // Портрет устройства: ключ встроенного изображения либо data-URL своей картинки.
  // До этого картинка выводилась из типа и роли, и пользователь не мог её сменить.
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN icon TEXT')
  // Типы «телефон/часы/наушники» убраны: приложение с ними ничего не делало, и карточка
  // такого устройства открывалась пустой. Уже заведённые записи переезжают в «другое» —
  // само устройство, его адрес и заметки остаются на месте, меняется только ярлык типа.
  d.exec(`UPDATE devices SET kind = 'other' WHERE kind IN ('phone', 'watch', 'buds')`)
  // C: MAC for Wake-on-LAN.
  addColumn(exec, 'ALTER TABLE devices ADD COLUMN mac TEXT')
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
    manual_renewal INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER
  )`)
  const addedManualRenewal = addColumn(
    exec,
    'ALTER TABLE subscriptions ADD COLUMN manual_renewal INTEGER NOT NULL DEFAULT 0'
  )
  if (addedManualRenewal) {
    // Старые записи один раз переезжают из notes. После миграции notes больше не
    // влияют на логику: владелец может явно снять флаг.
    const legacy = d.prepare('SELECT id, notes FROM subscriptions').all() as Array<{ id: string; notes: string | null }>
    const mark = d.prepare('UPDATE subscriptions SET manual_renewal = 1 WHERE id = ?')
    for (const row of legacy) if (legacyManualRenewal(row.notes)) mark.run(row.id)
  }
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
    disk REAL,
    status TEXT
  )`)
  // Дисковая тревога раньше имела правило, но не имела данных: snapshot отбрасывал disk.
  addColumn(exec, 'ALTER TABLE metric_snapshots ADD COLUMN disk REAL')
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
  // AI-доступ вместо «ключа провайдера». Имя таблицы осталось прежним намеренно: переезд на новое
  // имя означал бы копирование строк с ключами во временную таблицу, а это лишний способ потерять
  // ключи ради косметики. Наружу запись зовётся AiAccess.
  addColumn(exec, `ALTER TABLE ai_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'api'`)
  // На каком аккаунте/почте куплено. Подписок у владельца несколько, и без этого поля
  // «Claude Max» в списке ничем не отличается от второго такого же.
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN account TEXT')
  addColumn(exec, `ALTER TABLE ai_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`)
  // Деньги живут только в subscriptions; здесь — ссылка на них.
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN subscription_id TEXT')
  // Где ещё лежит значение ключа (env-переменная, KWallet) — ответ на «а если приложение снесут».
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN key_ref TEXT')
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN key_expires_at TEXT')
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN base_url TEXT')
  addColumn(exec, `ALTER TABLE ai_accounts ADD COLUMN payment TEXT NOT NULL DEFAULT 'card'`)
  // Трафик через чужой прокси. Признак хранится явно, потому что по одному имени провайдера
  // его не вывести: cli.neutrino.su выглядит как обычный OpenAI-совместимый эндпоинт.
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN third_party INTEGER NOT NULL DEFAULT 0')
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN used_by TEXT')
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN fallback_id TEXT')
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN limits_json TEXT')
  // Несколько аккаунтов одного провайдера, каждый со своим тарифом. Одной строкой `account`
  // это не выражается: «6 аккаунтов» не отвечает на вопрос, где именно лежит платный.
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN accounts_json TEXT')
  // Чем пользуются на аккаунте: веб, CLI, ключ. До этого каналы были отдельными записями
  // реестра, и одна квота показывалась дважды — у «ChatGPT» и у «Codex CLI».
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN channels_json TEXT')
  // Подтверждён ли аккаунт: входили, ответил ключ или владелец сказал сам.
  addColumn(exec, 'ALTER TABLE ai_accounts ADD COLUMN verified INTEGER NOT NULL DEFAULT 0')

  // Каталог цен. Не пользовательские данные, а кэш: вшитый снапшот LiteLLM + живой ответ
  // OpenRouter. Живёт в том же зашифрованном файле просто потому, что другой базы у приложения нет.
  d.exec(`CREATE TABLE IF NOT EXISTS ai_prices (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input REAL,
    output REAL,
    cache_write REAL,
    cache_write_1h REAL,
    cache_read REAL,
    context_tokens INTEGER,
    max_output_tokens INTEGER,
    mode TEXT,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    supports_tools INTEGER NOT NULL DEFAULT 0,
    supports_caching INTEGER NOT NULL DEFAULT 0,
    deprecated_at TEXT,
    source TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (provider, model)
  )`)

  // Какие модели доступны через конкретный доступ и по какой цене (наценка реселлера,
  // ручная замена цены, отметка «пользуюсь»).
  d.exec(`CREATE TABLE IF NOT EXISTS ai_access_models (
    access_id TEXT NOT NULL,
    model TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    markup_pct REAL,
    price_input REAL,
    price_output REAL,
    notes TEXT,
    PRIMARY KEY (access_id, model)
  )`)
  // Откуда модель в списке: спросили у провайдера или добавил владелец. Без этого нельзя
  // отличить исчезнувшую у провайдера модель от заведённой вручную и убрать первую.
  addColumn(exec, `ALTER TABLE ai_access_models ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`)
  addColumn(exec, 'ALTER TABLE ai_access_models ADD COLUMN fetched_at INTEGER')
  addColumn(exec, 'ALTER TABLE ai_access_models ADD COLUMN context_tokens INTEGER')

  // Агрегат расхода: дата × источник × модель. Сырые логи не копируем — они и так лежат на диске,
  // а их дублирование в зашифрованной базе только раздувало бы её.
  d.exec(`CREATE TABLE IF NOT EXISTS ai_usage_daily (
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cache_write_1h INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, source, model)
  )`)

  // Курсор на прочитанный файл: без него каждый проход перечитывал бы все 300+ файлов логов.
  // size вместе с mtime, потому что дописывание в конец файла mtime меняет, а вот усечение
  // и перезапись могут уложиться в ту же секунду — тогда спасает только размер.
  d.exec(`CREATE TABLE IF NOT EXISTS ai_usage_cursor (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    read_at INTEGER NOT NULL
  )`)

  // Идентификаторы уже учтённых ответов. Один ответ попадает в несколько файлов при возобновлении
  // сессии, и без этой таблицы возобновлённая сессия удваивала бы расход.
  d.exec(`CREATE TABLE IF NOT EXISTS ai_usage_seen (
    id TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  )`)

  // Учётные данные ОТДЕЛЬНЫХ аккаунтов внутри доступа. Отдельной таблицей, а не полем в
  // accounts_json: тот список целиком уходит в интерфейс, и секретам там не место.
  d.exec(`CREATE TABLE IF NOT EXISTS ai_account_secrets (
    access_id TEXT NOT NULL,
    email TEXT NOT NULL,
    password TEXT,
    api_key TEXT,
    check_status TEXT,
    checked_at INTEGER,
    PRIMARY KEY (access_id, email)
  )`)

  // Окна лимита подписки («сессии»). Дневных итогов для них мало: окно длится несколько часов
  // и начинается с первого обращения, а не в полночь.
  d.exec(`CREATE TABLE IF NOT EXISTS ai_usage_blocks (
    source TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, start_ts)
  )`)

  // Последний вердикт проверки ключа. Нужен двум потребителям: экрану — чтобы показать, когда
  // ключ в последний раз отвечал, и сторожу — чтобы заметить умерший ключ, НЕ ходя в сеть
  // самому (сторож только читает уже собранное, как и с метриками машин).
  d.exec(`CREATE TABLE IF NOT EXISTS ai_key_checks (
    access_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    remaining REAL,
    usage REAL,
    detail TEXT,
    checked_at INTEGER NOT NULL,
    /* Когда ключ последний раз ТОЧНО работал: по нему видно, «сломалось только что» или
       «не отвечает неделю». Ошибка сети этот момент не сбрасывает. */
    last_ok_at INTEGER
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
  altOs?: Array<{ ip: string; user?: string; os?: string; bootEntry?: string; port?: number }>
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
      icon: null,
      boot_entry: null,
      sort: i,
      created_at: now,
      updated_at: now
    }
  })
}

/**
 * Первичное наполнение базы.
 *
 * ДЕМО-ФЛОТ УБРАН НАМЕРЕННО. Раньше сюда писался список из seed.ts — реальная инфраструктура
 * автора (имена, хостеры, роли, цены, ссылки на панели управления). Для приложения, которое
 * выкладывается в open source, это и утечка чужих данных, и негодное первое впечатление:
 * новый пользователь видел шесть чужих серверов вместо пустого экрана со своими действиями.
 *
 * Осталась только загрузка СВОЕГО fleet.local.json — это осознанный локальный файл владельца,
 * его в поставке нет.
 */
function seedInto(d: Database.Database): void {
  const local = loadLocalFleet()
  if (!local || local.length === 0) return
  const stmt = d.prepare(INSERT_SQL)
  const insertAll = d.transaction((rows: DeviceRow[]) => {
    for (const r of rows) stmt.run(r)
  })
  insertAll(local)
}

export async function initialize(password: string): Promise<void> {
  if (isInitialized()) throw new Error('Vault already initialized')
  if (!password || password.length < 6) throw new Error('Master password must be at least 6 characters')
  const pendingPath = metaPath() + '.new'

  // Сначала на диск уходит ВОССТАНАВЛИВАЕМАЯ соль, и только затем создаётся база. Раньше
  // порядок был обратным: crash между migrate() и writeFile(meta) оставлял зашифрованный
  // файл без соли — ключ к нему был потерян навсегда.
  const meta = prepareVaultInitialization(dbPath(), metaPath())

  const keyHex = await deriveKeyHex(password, Buffer.from(meta.salt, 'hex'))
  const d = openEncrypted(keyHex)
  try {
    migrate(d)
    // Публикация атомарна. До неё initialize можно безопасно повторить с тем же паролем;
    // после неё обычный unlock видит полностью созданную схему.
    renameSync(pendingPath, metaPath())
    db = d
  } catch (e) {
    try {
      d.close()
    } catch {
      /* ignore */
    }
    throw e
  }
  // Заполнение своим парком — удобство, а не обязанность. Кривой fleet.local.json не повод
  // терять хранилище: пустое рабочее лучше сломанного.
  try {
    seedInto(d)
  } catch (e) {
    console.error('[vault] не удалось загрузить fleet.local.json, хранилище создано пустым:', (e as Error).message)
  }
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

  // Билет доступа берём ДО долгого вывода ключа: по нему видно, не заблокировали ли хранилище,
  // пока мы его открывали.
  const ticket = beginAccess()
  let cancelled = false
  let keyWasCorrect = false
  let schemaError: Error | null = null
  for (const cand of candidates) {
    const keyHex = await deriveKeyHex(password, Buffer.from(cand.salt, 'hex'))
    // ОТКРЫТИЕ ВНУТРИ try — и это принципиально.
    //
    // Предполагалось, что неверный ключ обнаружится на первом чтении ниже. На деле он
    // обнаруживается раньше: `openEncrypted` выставляет `journal_mode = WAL`, а эта прагма уже
    // трогает страницы базы и на чужом ключе бросает SQLITE_NOTADB. Пока вызов стоял снаружи,
    // ошибка вылетала мимо цикла — и ВТОРОЙ кандидат, та самая соль из `.new`, не пробовался
    // никогда. То есть согласование после сбоя между перешифровкой и публикацией соли не
    // работало вовсе: ровно тот случай, ради которого двухфазная фиксация и сделана.
    let d: Database.Database | null = null
    try {
      d = openEncrypted(keyHex)
      // Force key verification: a wrong key makes the first read throw.
      d.prepare('SELECT count(*) AS n FROM sqlite_master').get()
      // С этого места ПАРОЛЬ ТОЧНО ВЕРЕН: чтение зашифрованной базы удалось.
      // Всё, что упадёт дальше, — это про схему, а не про пароль. Раньше такая ошибка
      // проваливалась в общий catch и выходила наружу как «неверный мастер-пароль»:
      // человек до бесконечности перенабирал правильный пароль, а дело было не в нём.
      keyWasCorrect = true
      migrate(d) // idempotent — keeps schema current
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
      // Глобальное состояние меняем ПОСЛЕ файловой финализации. Если rename/unlink упадёт,
      // catch закроет только локальный d, а vaultStatus не соврёт «unlocked» закрытым handle.
      //
      // И только если за время работы никто не заблокировал хранилище. Вывод ключа занимает
      // сотни миллисекунд (Argon2id, 64 МиБ, 3 прохода), и всё это время `unlock` держит уже
      // открытое соединение, о котором `lock` ничего не знает: он видит `db === null`, честно
      // ничего не закрывает, а затем строка ниже вернула бы приложение в разблокированное
      // состояние ПОСЛЕ блокировки. Второе условие — про два одновременных `unlock`: первый
      // уже присвоил соединение, второе стало бы утечкой.
      //
      // Выходим из цикла, а не бросаем прямо здесь: бросок попал бы в общий catch ниже и был
      // бы засчитан как неподошедшая соль, то есть отменённая операция выглядела бы как
      // неверный пароль.
      if (!isAccessCurrent(ticket) || db) {
        try {
          d.close()
        } catch {
          /* ignore */
        }
        cancelled = true
        break
      }
      db = d
      return
    } catch (e) {
      // Первую такую ошибку и запоминаем: она относится к сработавшему ключу,
      // ошибки последующих кандидатов — уже про чужую соль.
      if (keyWasCorrect && !schemaError) schemaError = e as Error
      // `d` может быть null, если упало само открытие: неверный ключ обнаруживается ещё в
      // прагме, до того как соединение вернулось наружу.
      try {
        d?.close()
      } catch {
        /* ignore */
      }
    }
  }
  if (cancelled) {
    // Уже разблокировано параллельным вызовом — считаем задачу выполненной.
    if (isUnlocked()) return
    throw new Error('Хранилище заблокировали во время открытия — введи пароль ещё раз')
  }
  if (schemaError)
    throw new Error(`Пароль верный, но хранилище не открылось: ${schemaError.message}`)
  throw new Error('Invalid master password')
}

export function lock(): void {
  // Поколение растёт ДО закрытия соединения и независимо от того, кто нас позвал: `unlock`,
  // начатый раньше, обязан увидеть отмену, даже если lock пришёл не через общую блокировку.
  revokePendingAccess()
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
    mac: r.mac,
    icon: r.icon ?? null,
    bootEntry: r.boot_entry ?? null,
    hasScreenSecret: Boolean(r.screen_password),
    metricsKnown: false,
    metricsFresh: false
  }
}

/** JSON колонки alt → список AltBoot. Обратная совместимость: одиночный объект → [объект]. */
function parseAltOs(raw: string | null): AltBoot[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    const arr = Array.isArray(v) ? v : [v]
    return arr
      .map((o) => o as { ip?: string; user?: string; os?: string; bootEntry?: string; port?: number })
      .filter((o) => o && o.ip)
      .map((o) => ({
        ip: o.ip as string,
        user: o.user || 'root',
        os: o.os || '',
        bootEntry: o.bootEntry,
        port: Number(o.port) || undefined
      }))
  } catch {
    return []
  }
}

// ── Пароль трансляции экрана ───────────────────────────────────────────────────────────────────
// Лежит в том же SQLCipher-хранилище под мастер-паролем, что и SSH-секреты. В renderer уходит
// только факт наличия (hasScreenSecret), само значение через IPC не передаётся никогда.
export function setScreenPassword(id: string, password: string | null): void {
  requireDb()
    .prepare('UPDATE devices SET screen_password = ?, updated_at = ? WHERE id = ?')
    .run(password && password.length ? password : null, Date.now(), id)
}

export function getScreenPassword(id: string): string | null {
  const r = requireDb().prepare('SELECT screen_password FROM devices WHERE id = ?').get(id) as
    | { screen_password: string | null }
    | undefined
  return r?.screen_password || null
}

// Токен агента: живёт там же, под мастер-паролем. В renderer уходит только вместе с адресом
// подключения и только когда окно экрана реально открывают.
export function setAgentToken(id: string, token: string | null): void {
  requireDb()
    .prepare('UPDATE devices SET agent_token = ?, updated_at = ? WHERE id = ?')
    .run(token && token.length ? token : null, Date.now(), id)
}

export function getAgentToken(id: string): string | null {
  const r = requireDb().prepare('SELECT agent_token FROM devices WHERE id = ?').get(id) as
    | { agent_token: string | null }
    | undefined
  return r?.agent_token || null
}

/** Отпечаток TLS-сертификата агента: закрепляется при установке и потом только сверяется. */
export function setAgentCert(id: string, fp: string | null): void {
  requireDb()
    .prepare('UPDATE devices SET agent_cert = ?, updated_at = ? WHERE id = ?')
    .run(fp && fp.length ? fp : null, Date.now(), id)
}

export function getAgentCert(id: string): string | null {
  const r = requireDb().prepare('SELECT agent_cert FROM devices WHERE id = ?').get(id) as
    | { agent_cert: string | null }
    | undefined
  return r?.agent_cert || null
}

/** Последний снапшот по каждому устройству — одним запросом (для мгновенной отрисовки). */
function latestStates(): Map<
  string,
  {
    statusTs: number
    metricTs: number | null
    cpu: number | null
    ramUsed: number | null
    ramTotal: number | null
    disk: number | null
    status: string
    metricsFresh: boolean
  }
> {
  const d = requireDb()
  const statusRows = d
    .prepare(
      `SELECT s.device_id AS id, s.ts, s.status
         FROM metric_snapshots s
         JOIN (SELECT device_id, MAX(ts) AS mts FROM metric_snapshots GROUP BY device_id) m
           ON m.device_id = s.device_id AND m.mts = s.ts`
    )
    .all() as Array<{
      id: string
      ts: number
      status: string
    }>
  const metricRows = d
    .prepare(
      `SELECT s.device_id AS id, s.ts, s.cpu, s.ram_used AS ramUsed, s.ram_total AS ramTotal,
              s.disk
         FROM metric_snapshots s
         JOIN (
           SELECT device_id, MAX(ts) AS mts
             FROM metric_snapshots
            WHERE cpu IS NOT NULL OR ram_used IS NOT NULL OR ram_total IS NOT NULL OR disk IS NOT NULL
            GROUP BY device_id
         ) m ON m.device_id = s.device_id AND m.mts = s.ts`
    )
    .all() as Array<{
      id: string
      ts: number
      cpu: number | null
      ramUsed: number | null
      ramTotal: number | null
      disk: number | null
    }>
  const metrics = new Map(metricRows.map((r) => [r.id, r]))
  return new Map(
    statusRows.map((state) => {
      const metric = metrics.get(state.id)
      return [
        state.id,
        {
          statusTs: state.ts,
          metricTs: metric?.ts ?? null,
          cpu: metric?.cpu ?? null,
          ramUsed: metric?.ramUsed ?? null,
          ramTotal: metric?.ramTotal ?? null,
          disk: metric?.disk ?? null,
          status: state.status,
          metricsFresh: metric?.ts === state.ts
        }
      ]
    })
  )
}

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
      status: snapshotStatus(s.status) ?? dto.status,
      cpu: s.cpu ?? dto.cpu,
      ram: { used: s.ramUsed ?? dto.ram.used, total: s.ramTotal ?? dto.ram.total },
      disk: s.disk,
      metricsKnown: s.cpu !== null || s.ramUsed !== null || s.ramTotal !== null,
      metricsFresh: s.metricsFresh,
      lastSeen: s.metricTs
    }
  })
}

export function createDevice(input: DeviceInput): DeviceDTO {
  const d = requireDb()
  const now = Date.now()
  const nextSort = (d.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM devices').get() as { s: number }).s
  // Деньги проверяются, а не принимаются на слово: отрицательная сумма уменьшала общий
  // месячный расход и пряталась фильтром `usd > 0`, а неизвестная валюта молча получала курс 1.
  // Пересчёт в доллары делаем сами — арифметике из renderer в деньгах не место.
  const cost = parseDeviceCost(input.cost)
  const row: DeviceRow = {
    id: randomUUID(),
    name: text(input.name, 'Название устройства', 160, true),
    provider: text(input.provider, 'Провайдер', 160) || 'Custom',
    role: input.role ?? null,
    kind: input.kind ?? 'server',
    ip: input.ip ?? '',
    port: input.port ?? 22,
    user: input.user || 'root',
    country: input.country ?? '',
    flag: input.flag || '🖥️',
    os: input.os ?? '',
    // Наличие IP/секрета не доказывает, что машина сейчас отвечает.
    status: initialStatus(input.status),
    cpu: input.cpu ?? 0,
    ram_used: input.ram?.used ?? 0,
    ram_total: input.ram?.total ?? 0,
    cost_amount: cost.amount,
    cost_currency: cost.currency,
    cost_usd: toUsd(cost.amount, cost.currency),
    console_url: input.consoleUrl ?? '',
    auth_type: input.authType ?? (input.privateKey ? 'key' : input.password ? 'password' : 'none'),
    secret_password: input.password || null,
    secret_key: input.privateKey || null,
    secret_passphrase: input.passphrase || null,
    notes: input.notes ?? null,
    jump_id: input.jumpId ?? null,
    alt: input.altOs && input.altOs.length ? JSON.stringify(input.altOs) : null,
    mac: input.mac || null,
    icon: input.icon || null,
    boot_entry: input.bootEntry || null,
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
  // Правка проходит ТУ ЖЕ проверку, что и создание. Раньше её здесь не было вовсе: форма
  // редактирования принимала отрицательную сумму и неизвестную валюту, а те через курс 1
  // попадали в общий расход. Дыра ровно в том месте, куда чаще всего и заходят — менять цену
  // приходится чаще, чем заводить сервер.
  const cost = input.cost
    ? parseDeviceCost(input.cost)
    : { amount: cur.cost_amount, currency: cur.cost_currency as Currency }
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
    cost_usd: toUsd(cost.amount, cost.currency),
    console_url: input.consoleUrl ?? cur.console_url,
    auth_type: authType,
    secret_password: newSecret,
    secret_key: newKey,
    secret_passphrase: newPassphrase,
    notes: input.notes ?? cur.notes,
    jump_id: input.jumpId !== undefined ? input.jumpId : cur.jump_id,
    alt: input.altOs !== undefined ? (input.altOs.length ? JSON.stringify(input.altOs) : null) : cur.alt,
    mac: input.mac !== undefined ? input.mac || null : cur.mac,
    icon: input.icon !== undefined ? input.icon || null : (cur.icon ?? null),
    boot_entry: input.bootEntry !== undefined ? input.bootEntry || null : (cur.boot_entry ?? null),
    updated_at: Date.now()
  }
  d.prepare(
    `UPDATE devices SET
       name=@name, provider=@provider, role=@role, kind=@kind, ip=@ip, port=@port, user=@user,
       country=@country, flag=@flag, os=@os, status=@status, cpu=@cpu,
       ram_used=@ram_used, ram_total=@ram_total, cost_amount=@cost_amount,
       cost_currency=@cost_currency, cost_usd=@cost_usd, console_url=@console_url,
       auth_type=@auth_type, secret_password=@secret_password, secret_key=@secret_key,
       secret_passphrase=@secret_passphrase, notes=@notes, jump_id=@jump_id, alt=@alt, mac=@mac,
       icon=@icon, boot_entry=@boot_entry, updated_at=@updated_at
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
    // Кэш комплектующих тоже принадлежит устройству — иначе оставались висячие строки.
    d.prepare('DELETE FROM device_hardware WHERE device_id = ?').run(deviceId)
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
    .prepare(
      'SELECT ip, port, user, os, boot_entry, auth_type, secret_password, secret_key, secret_passphrase, alt, jump_id FROM devices WHERE id = ?'
    )
    .get(id) as
    | (ConnRow & { os: string; boot_entry: string | null; alt: string | null; jump_id: string | null })
    | undefined
  if (!r) return []
  // Jump-host обязателен и здесь. Без него устройство за бастионом было НАВСЕГДА «офлайн»:
  // быстрая проверка живости ходит именно через getOsEndpoints, ломилась напрямую и промахивалась,
  // а полный опрос такие хосты потом пропускал как заведомо мёртвые.
  const jump = getDeviceConn(id)?.jump
  const mkConn = (host: string, user: string, port?: number): DeviceConn => {
    const c: DeviceConn = {
      host,
      // Свой порт второй ОС, иначе порт основной записи.
      port: port || r.port || 22,
      user: user || 'root',
      authType: r.auth_type,
      password: r.secret_password
    }
    if (r.auth_type === 'key' && r.secret_key) {
      c.privateKey = r.secret_key
      c.passphrase = r.secret_passphrase
    }
    if (jump) c.jump = jump
    return c
  }
  const out: OsEndpoint[] = []
  // У ОСНОВНОЙ ОС тоже есть своя загрузочная запись: без неё переключение «из Windows в Linux»
  // не могло указать цель — Linux у двухзагрузочной машины обычно как раз основная система.
  if (r.ip && !r.ip.includes('x.x'))
    out.push({ os: r.os || '', bootEntry: r.boot_entry ?? undefined, conn: mkConn(r.ip, r.user) })
  const alts = parseAltOs(r.alt)
  for (const a of alts) out.push({ os: a.os, bootEntry: a.bootEntry, conn: mkConn(a.ip, a.user, a.port) })
  return out
}

/** TOFU host-key check: 'new' (just stored), 'match', or 'changed'. Main-process only. */
/**
 * Сверить ключ хоста с закреплённым.
 *
 * `commit` управляет тем, ЗАПИСЫВАТЬ ли новый ключ. По умолчанию — нет: проверка идёт в
 * рукопожатии, до аутентификации, и коннект по ошибочному адресу не должен навсегда закреплять
 * чужой ключ (после чего настоящий сервер читался бы как «ключ изменился»). Записывает
 * `makeHostVerifier.commit()` — уже после успешного входа.
 */
export function checkHostKey(
  host: string,
  port: number,
  keyHash: string,
  opts: { commit?: boolean } = {}
): 'new' | 'match' | 'changed' {
  const d = requireDb()
  const row = d.prepare('SELECT key_hash FROM known_hosts WHERE host = ? AND port = ?').get(host, port) as
    | { key_hash: string }
    | undefined
  if (!row) {
    if (opts.commit)
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
  const rows = requireDb()
    .prepare(
      `SELECT id, name, provider, category, amount, currency, period,
              next_renewal as nextRenewal, notes, manual_renewal as manualRenewal
         FROM subscriptions ORDER BY name`
    )
    .all() as Array<Omit<Subscription, 'manualRenewal'> & { manualRenewal: number }>
  return rows.map((row) => ({ ...row, manualRenewal: Boolean(row.manualRenewal) }))
}

export function createSubscription(input: SubscriptionInput): Subscription {
  const valid = parseSubscriptionInput(input)
  const sub: Subscription = {
    id: randomUUID(),
    name: valid.name,
    provider: valid.provider ?? '',
    category: valid.category ?? 'Other',
    amount: valid.amount,
    currency: valid.currency ?? 'USD',
    period: valid.period ?? 'mo',
    nextRenewal: valid.nextRenewal ?? null,
    notes: valid.notes ?? null,
    manualRenewal: valid.manualRenewal ?? false
  }
  requireDb()
    .prepare(
      `INSERT INTO subscriptions
         (id, name, provider, category, amount, currency, period, next_renewal, notes, manual_renewal, created_at)
       VALUES
         (@id, @name, @provider, @category, @amount, @currency, @period, @nextRenewal, @notes, @manual_renewal, @created_at)`
    )
    .run({ ...sub, manual_renewal: sub.manualRenewal ? 1 : 0, created_at: Date.now() })
  return sub
}

export function updateSubscription(id: string, input: SubscriptionInput): Subscription {
  const cur = listSubscriptions().find((s) => s.id === id)
  if (!cur) throw new Error('Подписка не найдена')
  const valid = parseSubscriptionInput(input)
  const sub: Subscription = {
    id,
    name: valid.name,
    provider: valid.provider ?? '',
    category: valid.category ?? 'Other',
    amount: valid.amount,
    currency: valid.currency ?? 'USD',
    period: valid.period ?? 'mo',
    nextRenewal: valid.nextRenewal ?? null,
    notes: valid.notes ?? null,
    manualRenewal: valid.manualRenewal ?? false
  }
  requireDb()
    .prepare(
      `UPDATE subscriptions SET name=@name, provider=@provider, category=@category, amount=@amount,
       currency=@currency, period=@period, next_renewal=@nextRenewal, notes=@notes,
       manual_renewal=@manual_renewal WHERE id=@id`
    )
    .run({ ...sub, manual_renewal: sub.manualRenewal ? 1 : 0 })
  return sub
}

export function deleteSubscription(id: string): boolean {
  const d = requireDb()
  return d.transaction((entityId: string): boolean => {
    d.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(entityId, entityId)
    return d.prepare('DELETE FROM subscriptions WHERE id = ?').run(entityId).changes > 0
  })(id)
}

export function listWallets(): Wallet[] {
  return requireDb().prepare('SELECT id, chain, address, label FROM wallets ORDER BY created_at').all() as Wallet[]
}

export function createWallet(input: WalletInput): Wallet {
  const valid = parseWalletInput(input)
  const d = requireDb()
  const duplicate = d
    .prepare('SELECT 1 FROM wallets WHERE upper(chain) = ? AND address = ?')
    .get(valid.chain, valid.address)
  if (duplicate) throw new Error('Этот кошелёк уже добавлен')
  const wallet: Wallet = {
    id: randomUUID(),
    chain: valid.chain,
    address: valid.address,
    label: valid.label ?? valid.chain
  }
  d
    .prepare('INSERT INTO wallets (id, chain, address, label, created_at) VALUES (@id, @chain, @address, @label, @created_at)')
    .run({ ...wallet, created_at: Date.now() })
  return wallet
}

export function updateWallet(id: string, input: WalletInput): Wallet {
  const cur = listWallets().find((w) => w.id === id)
  if (!cur) throw new Error('Кошелёк не найден')
  const valid = parseWalletInput(input)
  const d = requireDb()
  const duplicate = d
    .prepare('SELECT 1 FROM wallets WHERE upper(chain) = ? AND address = ? AND id <> ?')
    .get(valid.chain, valid.address, id)
  if (duplicate) throw new Error('Этот кошелёк уже добавлен')
  const wallet: Wallet = {
    id,
    chain: valid.chain,
    address: valid.address,
    label: valid.label ?? valid.chain
  }
  d.prepare('UPDATE wallets SET chain=@chain, address=@address, label=@label WHERE id=@id').run(wallet)
  return wallet
}

export function deleteWallet(id: string): boolean {
  const d = requireDb()
  return d.transaction((entityId: string): boolean => {
    d.prepare('DELETE FROM links WHERE from_id = ? OR to_id = ?').run(entityId, entityId)
    return d.prepare('DELETE FROM wallets WHERE id = ?').run(entityId).changes > 0
  })(id)
}

// Хранение истории метрик: до 5000 точек ИЛИ последние 60 дней на устройство (что раньше).
const SNAP_KEEP = 5000
const SNAP_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

/** Append a metric sample; обрезаем по возрасту (60 дней) и числу (5000) на устройство. */
export function recordSnapshot(
  deviceId: string,
  m: SnapshotInput
): void {
  const d = requireDb()
  d.prepare(METRIC_SNAPSHOT_INSERT).run(...snapshotValues(deviceId, Date.now(), m))
  d.prepare('DELETE FROM metric_snapshots WHERE device_id = ? AND ts < ?').run(deviceId, Date.now() - SNAP_MAX_AGE_MS)
  d.prepare(
    `DELETE FROM metric_snapshots WHERE device_id = ? AND rowid NOT IN
     (SELECT rowid FROM metric_snapshots WHERE device_id = ? ORDER BY ts DESC LIMIT ?)`
  ).run(deviceId, deviceId, SNAP_KEEP)
}

export function getSnapshots(deviceId: string, limit = 30): MetricSnapshot[] {
  const rows = requireDb()
    .prepare(
      'SELECT ts, cpu, ram_used as ramUsed, ram_total as ramTotal, disk, status FROM metric_snapshots WHERE device_id = ? ORDER BY ts DESC LIMIT ?'
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

// AI-доступы — api_key лежит в SQLCipher, наружу уходит только hasKey (значение никогда).

/** Строка таблицы как её отдаёт SQLite: булевы поля целыми, списки и лимиты — текстом. */
interface AiAccessRow {
  id: string
  kind: string
  provider: string
  label: string | null
  api_key: string | null
  plan: string | null
  account: string | null
  status: string | null
  subscription_id: string | null
  key_ref: string | null
  key_expires_at: string | null
  base_url: string | null
  payment: string | null
  third_party: number | null
  used_by: string | null
  fallback_id: string | null
  limits_json: string | null
  accounts_json?: string | null
  channels_json?: string | null
  verified?: number | null
  notes: string | null
  created_at?: number | null
}

const AI_KINDS: AiKind[] = ['subscription', 'api', 'router', 'free-tier', 'local', 'cli-agent']
const AI_STATUSES: AiStatus[] = ['active', 'paused', 'expired', 'planned']
const AI_PAYMENTS: AiPayment[] = ['card', 'crypto', 'reseller', 'free']

/** Разбор списка инструментов. Битый JSON = «список неизвестен», а не падение экрана. */
function parseUsedBy(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Разбор списка аккаунтов. Битый JSON = «списка нет», а не падение экрана. */
function parseAccounts(raw: string | null): AiAccountEntry[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((v): v is AiAccountEntry => Boolean(v) && typeof v === 'object' && typeof (v as AiAccountEntry).email === 'string')
      .map((v) => ({ email: v.email, plan: v.plan, note: v.note, primary: v.primary }))
  } catch {
    return []
  }
}

/** Разбор каналов. Битый JSON = «каналы неизвестны», а не падение экрана. */
function parseChannels(raw: string | null): AiChannel[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is AiChannel => Boolean(v) && typeof v === 'object' && typeof (v as AiChannel).label === 'string'
    )
  } catch {
    return []
  }
}

function parseLimits(raw: string | null): AiLimits {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as AiLimits) : {}
  } catch {
    return {}
  }
}

function toAccess(r: AiAccessRow): AiAccess {
  return {
    id: r.id,
    // Значение из базы могло прийти из ручной правки или из будущей версии схемы: неизвестный
    // тип показываем как обычный api-доступ, но запись не теряем.
    kind: AI_KINDS.includes(r.kind as AiKind) ? (r.kind as AiKind) : 'api',
    provider: r.provider,
    label: r.label || r.provider,
    account: r.account ?? '',
    plan: r.plan ?? '',
    status: AI_STATUSES.includes(r.status as AiStatus) ? (r.status as AiStatus) : 'active',
    subscriptionId: r.subscription_id,
    hasKey: Boolean(r.api_key),
    keyRef: r.key_ref,
    keyExpiresAt: r.key_expires_at,
    baseUrl: r.base_url,
    payment: AI_PAYMENTS.includes(r.payment as AiPayment) ? (r.payment as AiPayment) : 'card',
    thirdParty: Boolean(r.third_party),
    usedBy: parseUsedBy(r.used_by),
    fallbackId: r.fallback_id,
    limits: parseLimits(r.limits_json),
    accounts: parseAccounts(r.accounts_json ?? null),
    channels: parseChannels(r.channels_json ?? null),
    verified: Boolean(r.verified),
    notes: r.notes,
    createdAt: r.created_at ?? 0
  }
}

const AI_COLUMNS = `id, kind, provider, label, api_key, plan, account, status, subscription_id,
   key_ref, key_expires_at, base_url, payment, third_party, used_by, fallback_id, limits_json,
   accounts_json, channels_json, verified, notes`
const AI_SELECT = `${AI_COLUMNS}, created_at`

export function listAiAccess(): AiAccess[] {
  const rows = requireDb()
    .prepare(`SELECT ${AI_SELECT} FROM ai_accounts ORDER BY created_at`)
    .all() as AiAccessRow[]
  return rows.map((r) => {
    const access = toAccess(r)
    if (access.accounts.length === 0) return access
    // Признаки «пароль есть» и «ключ есть» живут в другой таблице — сами значения интерфейсу
    // не показываются никогда, но знать об их наличии он обязан.
    const flags = new Map(listAccountSecretFlags(access.id).map((f) => [f.email, f]))
    return {
      ...access,
      accounts: access.accounts.map((a) => {
        const f = flags.get(a.email)
        return f
          ? { ...a, hasPassword: f.hasPassword, hasKey: f.hasKey, checkStatus: f.checkStatus ?? undefined, checkedAt: f.checkedAt ?? undefined }
          : a
      })
    }
  })
}

export function createAiAccess(input: AiAccessInput): AiAccess {
  const id = randomUUID()
  const row = {
    id,
    kind: input.kind ?? 'api',
    provider: input.provider,
    label: input.label?.trim() || input.provider,
    api_key: input.apiKey || null,
    plan: input.plan ?? '',
    account: input.account ?? '',
    status: input.status ?? 'active',
    subscription_id: input.subscriptionId ?? null,
    key_ref: input.keyRef ?? null,
    key_expires_at: input.keyExpiresAt ?? null,
    base_url: input.baseUrl ?? null,
    payment: input.payment ?? 'card',
    third_party: input.thirdParty ? 1 : 0,
    used_by: JSON.stringify(input.usedBy ?? []),
    fallback_id: input.fallbackId ?? null,
    limits_json: JSON.stringify(input.limits ?? {}),
    accounts_json: JSON.stringify(input.accounts ?? []),
    channels_json: JSON.stringify(input.channels ?? []),
    verified: input.verified ? 1 : 0,
    notes: input.notes ?? null,
    created_at: Date.now()
  }
  requireDb()
    .prepare(
      `INSERT INTO ai_accounts (${AI_COLUMNS}, created_at)
       VALUES (@id, @kind, @provider, @label, @api_key, @plan, @account, @status, @subscription_id,
               @key_ref, @key_expires_at, @base_url, @payment, @third_party, @used_by, @fallback_id,
               @limits_json, @accounts_json, @channels_json, @verified, @notes, @created_at)`
    )
    .run(row)
  return toAccess(row)
}

export function updateAiAccess(id: string, input: AiAccessInput): AiAccess {
  const d = requireDb()
  const cur = d.prepare(`SELECT ${AI_SELECT} FROM ai_accounts WHERE id = ?`).get(id) as AiAccessRow | undefined
  if (!cur) throw new Error('AI-доступ не найден')
  // Пустой apiKey на правке = оставить текущий ключ (частый случай — правим только метку или план).
  const next = {
    id,
    kind: input.kind ?? cur.kind,
    provider: input.provider ?? cur.provider,
    label: input.label?.trim() || cur.label || (input.provider ?? cur.provider),
    api_key: input.apiKey ? input.apiKey : cur.api_key,
    plan: input.plan ?? cur.plan ?? '',
    account: input.account ?? cur.account ?? '',
    status: input.status ?? cur.status ?? 'active',
    subscription_id: input.subscriptionId !== undefined ? input.subscriptionId : cur.subscription_id,
    key_ref: input.keyRef !== undefined ? input.keyRef : cur.key_ref,
    key_expires_at: input.keyExpiresAt !== undefined ? input.keyExpiresAt : cur.key_expires_at,
    base_url: input.baseUrl !== undefined ? input.baseUrl : cur.base_url,
    payment: input.payment ?? cur.payment ?? 'card',
    third_party: (input.thirdParty ?? Boolean(cur.third_party)) ? 1 : 0,
    used_by: input.usedBy !== undefined ? JSON.stringify(input.usedBy) : (cur.used_by ?? '[]'),
    fallback_id: input.fallbackId !== undefined ? input.fallbackId : cur.fallback_id,
    limits_json: input.limits !== undefined ? JSON.stringify(input.limits) : (cur.limits_json ?? '{}'),
    accounts_json: input.accounts !== undefined ? JSON.stringify(input.accounts) : (cur.accounts_json ?? '[]'),
    channels_json: input.channels !== undefined ? JSON.stringify(input.channels) : (cur.channels_json ?? '[]'),
    verified: (input.verified ?? Boolean(cur.verified)) ? 1 : 0,
    notes: input.notes !== undefined ? input.notes : cur.notes
  }
  d.prepare(
    `UPDATE ai_accounts SET kind=@kind, provider=@provider, label=@label, api_key=@api_key,
       plan=@plan, account=@account, status=@status, subscription_id=@subscription_id,
       key_ref=@key_ref, key_expires_at=@key_expires_at, base_url=@base_url, payment=@payment,
       third_party=@third_party, used_by=@used_by, fallback_id=@fallback_id,
       limits_json=@limits_json, accounts_json=@accounts_json, channels_json=@channels_json,
       verified=@verified, notes=@notes WHERE id=@id`
  ).run(next)
  // Дата создания в UPDATE не участвует (её нет среди именованных параметров — better-sqlite3
  // отвергает лишние), но в ответе она нужна: без неё правка обнуляла бы возраст записи.
  return toAccess({ ...next, created_at: cur.created_at })
}

export function deleteAiAccess(id: string): void {
  const d = requireDb()
  d.prepare('DELETE FROM ai_accounts WHERE id = ?').run(id)
  // Привязки моделей пережили бы удаление доступа и всплыли бы у следующего с тем же id
  // (идентификаторы случайные, но чужие строки в базе — всё равно мусор).
  d.prepare('DELETE FROM ai_access_models WHERE access_id = ?').run(id)
  deleteAccountSecrets(id)
  // Ссылка «чем заменить» указывала на удалённую запись — обнуляем, иначе интерфейс покажет
  // фолбэк, которого нет.
  d.prepare('UPDATE ai_accounts SET fallback_id = NULL WHERE fallback_id = ?').run(id)
}

// --- Каталог цен ---------------------------------------------------------------------------

/** Массовая запись каталога. Одной транзакцией: 3000 отдельных INSERT занимают секунды. */
export function upsertAiPrices(prices: AiPrice[]): number {
  const d = requireDb()
  const stmt = d.prepare(
    `INSERT INTO ai_prices (provider, model, input, output, cache_write, cache_write_1h, cache_read,
       context_tokens, max_output_tokens, mode, supports_vision, supports_tools, supports_caching,
       deprecated_at, source, fetched_at)
     VALUES (@provider, @model, @input, @output, @cacheWrite, @cacheWrite1h, @cacheRead,
       @contextTokens, @maxOutputTokens, @mode, @supportsVision, @supportsTools, @supportsCaching,
       @deprecatedAt, @source, @fetchedAt)
     ON CONFLICT(provider, model) DO UPDATE SET
       input=excluded.input, output=excluded.output, cache_write=excluded.cache_write,
       cache_write_1h=excluded.cache_write_1h, cache_read=excluded.cache_read,
       context_tokens=excluded.context_tokens, max_output_tokens=excluded.max_output_tokens,
       mode=excluded.mode, supports_vision=excluded.supports_vision,
       supports_tools=excluded.supports_tools, supports_caching=excluded.supports_caching,
       deprecated_at=excluded.deprecated_at, source=excluded.source, fetched_at=excluded.fetched_at`
  )
  const write = d.transaction((list: AiPrice[]) => {
    for (const p of list)
      stmt.run({
        ...p,
        supportsVision: p.supportsVision ? 1 : 0,
        supportsTools: p.supportsTools ? 1 : 0,
        supportsCaching: p.supportsCaching ? 1 : 0
      })
  })
  write(prices)
  return prices.length
}

function toPrice(r: Record<string, unknown>): AiPrice {
  return {
    provider: r.provider as string,
    model: r.model as string,
    input: (r.input as number) ?? null,
    output: (r.output as number) ?? null,
    cacheWrite: (r.cache_write as number) ?? null,
    cacheWrite1h: (r.cache_write_1h as number) ?? null,
    cacheRead: (r.cache_read as number) ?? null,
    contextTokens: (r.context_tokens as number) ?? null,
    maxOutputTokens: (r.max_output_tokens as number) ?? null,
    mode: (r.mode as string) ?? null,
    supportsVision: Boolean(r.supports_vision),
    supportsTools: Boolean(r.supports_tools),
    supportsCaching: Boolean(r.supports_caching),
    deprecatedAt: (r.deprecated_at as string) ?? null,
    source: (r.source as AiPrice['source']) ?? 'catalog',
    fetchedAt: (r.fetched_at as number) ?? 0
  }
}

export function listAiPrices(provider?: string): AiPrice[] {
  const d = requireDb()
  const rows = provider
    ? (d.prepare('SELECT * FROM ai_prices WHERE provider = ? ORDER BY model').all(provider) as Array<Record<string, unknown>>)
    : (d.prepare('SELECT * FROM ai_prices ORDER BY provider, model').all() as Array<Record<string, unknown>>)
  return rows.map(toPrice)
}

/** Цена одной модели. Сначала точное совпадение, потом — без префикса провайдера. */
export function findAiPrice(model: string): AiPrice | null {
  const d = requireDb()
  const exact = d.prepare('SELECT * FROM ai_prices WHERE model = ? LIMIT 1').get(model) as Record<string, unknown> | undefined
  if (exact) return toPrice(exact)
  // Логи Claude Code пишут «claude-opus-4-7», а каталог знает «anthropic/claude-opus-4-7».
  const suffix = d.prepare("SELECT * FROM ai_prices WHERE model LIKE ? LIMIT 1").get(`%/${model}`) as
    | Record<string, unknown>
    | undefined
  return suffix ? toPrice(suffix) : null
}

export function aiPriceCount(): number {
  const r = requireDb().prepare('SELECT COUNT(*) as n FROM ai_prices').get() as { n: number }
  return r.n
}

// --- Модели доступа ------------------------------------------------------------------------

export function listAccessModels(accessId: string): AiAccessModel[] {
  const rows = requireDb()
    .prepare('SELECT * FROM ai_access_models WHERE access_id = ? ORDER BY model').all(accessId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    accessId: r.access_id as string,
    model: r.model as string,
    favorite: Boolean(r.favorite),
    markupPct: (r.markup_pct as number) ?? null,
    priceInput: (r.price_input as number) ?? null,
    priceOutput: (r.price_output as number) ?? null,
    notes: (r.notes as string) ?? null,
    source: ((r.source as string) ?? 'manual') as AiAccessModel['source'],
    fetchedAt: (r.fetched_at as number) ?? null,
    contextTokens: (r.context_tokens as number) ?? null
  }))
}

/**
 * Заменить список моделей, полученных от провайдера.
 *
 * Ручные записи и отметки «пользуюсь» переживают обновление: провайдер знает про свой перечень,
 * но не про то, что владелец с ним делает. Модели, исчезнувшие из ответа, удаляются — иначе
 * список копил бы отключённые версии годами.
 */
export function replaceFetchedModels(
  accessId: string,
  models: Array<{ id: string; contextTokens?: number | null }>
): { added: number; removed: number } {
  const d = requireDb()
  const before = listAccessModels(accessId)
  const favorites = new Map(before.map((m) => [m.model, m]))
  const incoming = new Set(models.map((m) => m.id))

  const run = d.transaction(() => {
    const stale = before.filter((m) => m.source === 'api' && !incoming.has(m.model) && !m.favorite)
    const drop = d.prepare('DELETE FROM ai_access_models WHERE access_id = ? AND model = ?')
    for (const m of stale) drop.run(accessId, m.model)

    const upsert = d.prepare(
      `INSERT INTO ai_access_models (access_id, model, favorite, markup_pct, price_input, price_output,
         notes, source, fetched_at, context_tokens)
       VALUES (@accessId, @model, @favorite, @markupPct, @priceInput, @priceOutput, @notes, 'api', @fetchedAt, @contextTokens)
       ON CONFLICT(access_id, model) DO UPDATE SET source='api', fetched_at=excluded.fetched_at,
         context_tokens=COALESCE(excluded.context_tokens, context_tokens)`
    )
    const now = Date.now()
    for (const m of models) {
      const prev = favorites.get(m.id)
      upsert.run({
        accessId,
        model: m.id,
        favorite: prev?.favorite ? 1 : 0,
        markupPct: prev?.markupPct ?? null,
        priceInput: prev?.priceInput ?? null,
        priceOutput: prev?.priceOutput ?? null,
        notes: prev?.notes ?? null,
        fetchedAt: now,
        contextTokens: m.contextTokens ?? null
      })
    }
    return { added: models.filter((m) => !favorites.has(m.id)).length, removed: stale.length }
  })
  return run()
}

export function setAccessModel(m: AiAccessModel): void {
  requireDb()
    .prepare(
      `INSERT INTO ai_access_models (access_id, model, favorite, markup_pct, price_input, price_output, notes)
       VALUES (@accessId, @model, @favorite, @markupPct, @priceInput, @priceOutput, @notes)
       ON CONFLICT(access_id, model) DO UPDATE SET favorite=excluded.favorite,
         markup_pct=excluded.markup_pct, price_input=excluded.price_input,
         price_output=excluded.price_output, notes=excluded.notes`
    )
    .run({ ...m, favorite: m.favorite ? 1 : 0 })
}

export function deleteAccessModel(accessId: string, model: string): void {
  requireDb().prepare('DELETE FROM ai_access_models WHERE access_id = ? AND model = ?').run(accessId, model)
}

// --- Расход --------------------------------------------------------------------------------

export function listUsageDays(sinceDate?: string): AiUsageDay[] {
  const d = requireDb()
  const rows = sinceDate
    ? (d.prepare('SELECT * FROM ai_usage_daily WHERE date >= ? ORDER BY date').all(sinceDate) as Array<Record<string, unknown>>)
    : (d.prepare('SELECT * FROM ai_usage_daily ORDER BY date').all() as Array<Record<string, unknown>>)
  return rows.map((r) => ({
    date: r.date as string,
    source: r.source as string,
    model: r.model as string,
    input: r.input as number,
    output: r.output as number,
    cacheWrite: r.cache_write as number,
    cacheWrite1h: r.cache_write_1h as number,
    cacheRead: r.cache_read as number,
    requests: r.requests as number,
    costUsd: r.cost_usd as number
  }))
}

/** Прибавить к дневному итогу. Именно прибавить: проход читает только НОВЫЙ хвост файлов. */
export function addUsage(days: AiUsageDay[]): void {
  const d = requireDb()
  const stmt = d.prepare(
    `INSERT INTO ai_usage_daily (date, source, model, input, output, cache_write, cache_write_1h,
       cache_read, requests, cost_usd)
     VALUES (@date, @source, @model, @input, @output, @cacheWrite, @cacheWrite1h, @cacheRead,
       @requests, @costUsd)
     ON CONFLICT(date, source, model) DO UPDATE SET
       input = input + excluded.input,
       output = output + excluded.output,
       cache_write = cache_write + excluded.cache_write,
       cache_write_1h = cache_write_1h + excluded.cache_write_1h,
       cache_read = cache_read + excluded.cache_read,
       requests = requests + excluded.requests,
       cost_usd = cost_usd + excluded.cost_usd`
  )
  const write = d.transaction((list: AiUsageDay[]) => {
    for (const day of list) stmt.run(day)
  })
  write(days)
}

export interface UsageCursor {
  path: string
  size: number
  mtime: number
  offset: number
}

export function getUsageCursor(path: string): UsageCursor | null {
  const r = requireDb().prepare('SELECT path, size, mtime, offset FROM ai_usage_cursor WHERE path = ?').get(path) as
    | UsageCursor
    | undefined
  return r ?? null
}

export function setUsageCursor(c: UsageCursor): void {
  requireDb()
    .prepare(
      `INSERT INTO ai_usage_cursor (path, size, mtime, offset, read_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
         offset=excluded.offset, read_at=excluded.read_at`
    )
    .run(c.path, c.size, c.mtime, c.offset, Date.now())
}

/** Отсеять уже учтённые ответы и запомнить новые. Возвращает те, которых раньше не видели. */
export function filterUnseenUsage(ids: string[]): Set<string> {
  const d = requireDb()
  const has = d.prepare('SELECT 1 FROM ai_usage_seen WHERE id = ?')
  const remember = d.prepare('INSERT OR IGNORE INTO ai_usage_seen (id, seen_at) VALUES (?, ?)')
  const fresh = new Set<string>()
  const run = d.transaction((list: string[]) => {
    const now = Date.now()
    for (const id of list) {
      if (has.get(id)) continue
      remember.run(id, now)
      fresh.add(id)
    }
  })
  run(ids)
  return fresh
}

// --- Учётные данные отдельных аккаунтов ---

export interface AiAccountSecretRow {
  email: string
  hasPassword: boolean
  hasKey: boolean
  checkStatus: string | null
  checkedAt: number | null
}

/** Признаки наличия секретов — это всё, что вправе увидеть интерфейс. */
export function listAccountSecretFlags(accessId: string): AiAccountSecretRow[] {
  const rows = requireDb()
    .prepare('SELECT email, password, api_key, check_status, checked_at FROM ai_account_secrets WHERE access_id = ?')
    .all(accessId) as Array<{ email: string; password: string | null; api_key: string | null; check_status: string | null; checked_at: number | null }>
  return rows.map((r) => ({
    email: r.email,
    hasPassword: Boolean(r.password),
    hasKey: Boolean(r.api_key),
    checkStatus: r.check_status,
    checkedAt: r.checked_at
  }))
}

/** Сохранить пароль и/или ключ аккаунта. Пустая строка стирает значение, undefined — не трогает. */
export function setAccountSecret(
  accessId: string,
  email: string,
  patch: { password?: string; apiKey?: string }
): void {
  const d = requireDb()
  const cur = d
    .prepare('SELECT password, api_key FROM ai_account_secrets WHERE access_id = ? AND email = ?')
    .get(accessId, email) as { password: string | null; api_key: string | null } | undefined
  const password = patch.password === undefined ? (cur?.password ?? null) : patch.password || null
  const apiKey = patch.apiKey === undefined ? (cur?.api_key ?? null) : patch.apiKey || null
  d.prepare(
    `INSERT INTO ai_account_secrets (access_id, email, password, api_key)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(access_id, email) DO UPDATE SET password = excluded.password, api_key = excluded.api_key`
  ).run(accessId, email, password, apiKey)
}

/** Main-process only: значение пароля. Наружу не отдаётся — только в буфер обмена или в форму входа. */
export function getAccountPassword(accessId: string, email: string): string | null {
  const r = requireDb()
    .prepare('SELECT password FROM ai_account_secrets WHERE access_id = ? AND email = ?')
    .get(accessId, email) as { password: string | null } | undefined
  return r?.password ?? null
}

/** Main-process only: ключ конкретного аккаунта. */
export function getAccountKey(accessId: string, email: string): string | null {
  const r = requireDb()
    .prepare('SELECT api_key FROM ai_account_secrets WHERE access_id = ? AND email = ?')
    .get(accessId, email) as { api_key: string | null } | undefined
  return r?.api_key ?? null
}

export function recordAccountCheck(accessId: string, email: string, status: string): void {
  requireDb()
    .prepare(
      `INSERT INTO ai_account_secrets (access_id, email, check_status, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(access_id, email) DO UPDATE SET check_status = excluded.check_status, checked_at = excluded.checked_at`
    )
    .run(accessId, email, status, Date.now())
}

/** Удаление доступа уносит и учётные данные его аккаунтов. */
function deleteAccountSecrets(accessId: string): void {
  requireDb().prepare('DELETE FROM ai_account_secrets WHERE access_id = ?').run(accessId)
}

// --- Окна лимита ---

export function listUsageBlocks(source?: string): AiUsageBlock[] {
  const d = requireDb()
  const rows = source
    ? (d.prepare('SELECT * FROM ai_usage_blocks WHERE source = ? ORDER BY start_ts').all(source) as Array<Record<string, unknown>>)
    : (d.prepare('SELECT * FROM ai_usage_blocks ORDER BY start_ts').all() as Array<Record<string, unknown>>)
  return rows.map((r) => ({
    source: r.source as string,
    startTs: r.start_ts as number,
    endTs: r.end_ts as number,
    tokens: r.tokens as number,
    costUsd: r.cost_usd as number,
    requests: r.requests as number
  }))
}

/** Прибавить к окнам. Как и дневные итоги, проход читает только новый хвост логов. */
export function addUsageBlocks(blocks: AiUsageBlock[]): void {
  const d = requireDb()
  const stmt = d.prepare(
    `INSERT INTO ai_usage_blocks (source, start_ts, end_ts, tokens, cost_usd, requests)
     VALUES (@source, @startTs, @endTs, @tokens, @costUsd, @requests)
     ON CONFLICT(source, start_ts) DO UPDATE SET
       tokens = tokens + excluded.tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       requests = requests + excluded.requests,
       end_ts = MAX(end_ts, excluded.end_ts)`
  )
  const write = d.transaction((list: AiUsageBlock[]) => {
    for (const b of list) stmt.run(b)
  })
  write(blocks)
}

// --- Вердикты проверки ключей ----------------------------------------------------------------

export interface AiKeyCheckRow {
  accessId: string
  status: string
  remaining: number | null
  usage: number | null
  detail: string | null
  checkedAt: number
  lastOkAt: number | null
}

/**
 * Запомнить результат проверки.
 *
 * `lastOkAt` двигается только на подтверждённо рабочем ключе. Сетевая ошибка его НЕ сбрасывает:
 * «не смогли спросить» — это не «перестал работать», и путать их значит будить владельца
 * каждый раз, когда отвалился интернет.
 */
export function recordAiCheck(accessId: string, check: { status: string; remaining?: number | null; usage?: number | null; detail?: string }): void {
  const d = requireDb()
  const now = Date.now()
  const alive = check.status === 'valid' || check.status === 'quota'
  d.prepare(
    `INSERT INTO ai_key_checks (access_id, status, remaining, usage, detail, checked_at, last_ok_at)
     VALUES (@accessId, @status, @remaining, @usage, @detail, @checkedAt, @lastOkAt)
     ON CONFLICT(access_id) DO UPDATE SET status=excluded.status, remaining=excluded.remaining,
       usage=excluded.usage, detail=excluded.detail, checked_at=excluded.checked_at,
       last_ok_at=COALESCE(excluded.last_ok_at, ai_key_checks.last_ok_at)`
  ).run({
    accessId,
    status: check.status,
    remaining: check.remaining ?? null,
    usage: check.usage ?? null,
    detail: check.detail ?? null,
    checkedAt: now,
    lastOkAt: alive ? now : null
  })
}

export function listAiChecks(): AiKeyCheckRow[] {
  return requireDb()
    .prepare(
      `SELECT access_id as accessId, status, remaining, usage, detail,
              checked_at as checkedAt, last_ok_at as lastOkAt FROM ai_key_checks`
    )
    .all() as AiKeyCheckRow[]
}

/** Когда последний раз читали логи. null — ни разу. */
export function lastUsageScan(): number | null {
  const r = requireDb().prepare('SELECT MAX(read_at) as t FROM ai_usage_cursor').get() as { t: number | null }
  return r?.t ?? null
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
