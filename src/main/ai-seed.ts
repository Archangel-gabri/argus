// Засев реестра AI-доступов из локального файла.
//
// Тот же приём, что и с флотом (`fleet.local.json`): настоящие данные владельца лежат рядом с
// приложением, в git не попадают, а в код и в репозиторий не уезжают ни ключи, ни почты.
//
// Значения ключей в самом файле держать не обязательно и не нужно: запись может сослаться на
// имя переменной в env-файле (`secrets/env/api-keys.env`, права 600), и Argus прочитает
// значение оттуда при засеве. Так единственная копия ключа остаётся там, где владелец её и
// хранит, а в зашифрованный вольт попадает уже готовое значение.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findSeedFile } from './seed-file'
import type { AiAccess, AiAccessInput, AiAccountEntry, AiChannel, AiKind, AiLimits, AiPayment, AiStatus } from './types'
import * as vault from './vault'

interface SeedSubscription {
  name: string
  provider?: string
  category?: string
  amount: number
  currency?: string
  period?: 'mo' | 'yr'
  nextRenewal?: string | null
  manualRenewal?: boolean
  notes?: string | null
}

interface SeedAccess {
  kind?: AiKind
  provider: string
  label?: string
  account?: string
  accounts?: AiAccountEntry[]
  plan?: string
  status?: AiStatus
  payment?: AiPayment
  thirdParty?: boolean
  baseUrl?: string
  keyRef?: string
  keyExpiresAt?: string
  usedBy?: string[]
  channels?: AiChannel[]
  verified?: boolean
  limits?: AiLimits
  notes?: string
  /** Значение ключа прямо в файле — путь для тех случаев, когда env-файла нет. */
  apiKey?: string
  /** Имя переменной в env-файле: значение подставится при засеве. */
  apiKeyEnv?: string
  /** Метка доступа, который служит запасным вариантом (сопоставляется по label). */
  fallback?: string
  /** Подписка, из которой берутся деньги. Создаётся, если такой ещё нет. */
  subscription?: SeedSubscription
}

interface SeedFile {
  /** Абсолютный путь к env-файлу с ключами (`~` раскрывается). */
  envFile?: string
  access: SeedAccess[]
  /**
   * Записи, которые надо УБРАТЬ из реестра (по названию).
   *
   * Просто удалить их из `access` мало: засев только добавляет и дополняет, поэтому однажды
   * заведённая запись жила бы вечно. Список удаляемых делает выбывание явным — и не даёт
   * снести случайно то, что владелец завёл руками: убирается только названное поимённо.
   */
  retire?: string[]
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p
}

/**
 * Разбор env-файла вида `KEY=value`.
 *
 * Значения не логируются и наружу не отдаются — функция возвращает карту только вызывающему,
 * который кладёт ключ прямиком в зашифрованное хранилище.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    // Кавычки вокруг значения — часть синтаксиса файла, а не самого ключа.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    )
      value = value.slice(1, -1)
    if (key) out[key] = value
  }
  return out
}

function seedPath(): string | null {
  return findSeedFile('ai.local.json')
}

export interface SeedResult {
  created: number
  /** Сколько уже заведённых записей дополнили данными из файла. */
  updated: number
  /** Сколько записей убрали как выбывшие. */
  retired: number
  subscriptions: number
  /** Записи, которым в файле обещан ключ, но взять его негде. */
  missingKeys: string[]
}

/** Как запись зовётся в реестре: своя метка, а если её нет — имя провайдера. */
export function seedLabel(item: { label?: string; provider: string }): string {
  return (item.label ?? item.provider).trim()
}

/**
 * Какие записи файла ещё не заведены.
 *
 * Сравнение по метке без учёта регистра. Дозасев по имени, а не «только на пустой таблице»:
 * иначе один заведённый вручную доступ навсегда закрывал бы дорогу остальным девятнадцати.
 * Существующие записи при этом НЕ трогаются — правки владельца важнее файла.
 */
export function pickMissing<T extends { label?: string; provider: string }>(existingLabels: string[], items: T[]): T[] {
  const known = new Set(existingLabels.map((l) => l.trim().toLowerCase()))
  const out: T[] = []
  for (const item of items) {
    const key = seedLabel(item).toLowerCase()
    // Дубль внутри самого файла тоже отсекаем — иначе он приедет в базу дважды.
    if (known.has(key)) continue
    known.add(key)
    out.push(item)
  }
  return out
}

/**
 * Чем дополнить УЖЕ заведённую запись.
 *
 * Дозасев по именам решал только половину задачи: когда в файл добавляли новые поля (список
 * аккаунтов, окно лимита), запись в хранилище оставалась прежней, и владелец не видел ничего
 * нового, пока не заводил доступ заново.
 *
 * Дополняются ТОЛЬКО пустые места. Всё, что владелец заполнил или поправил руками, файл не
 * трогает: он источник первичных данных, а не хозяин записи.
 */
export function fillGaps(existing: AiAccess, item: SeedAccess): AiAccessInput | null {
  const patch: AiAccessInput = { provider: existing.provider }
  let changed = false

  // Проверенный факт из файла ПЕРЕЗАПИСЫВАЕТ прежнюю догадку. Иначе однажды записанное
  // «тариф не подтверждён» остаётся навсегда: поле не пустое, а значит дополнению не подлежит —
  // и результат живой проверки некуда положить.
  if (item.verified) {
    if (item.plan && item.plan !== existing.plan) {
      patch.plan = item.plan
      changed = true
    }
    if (item.notes && item.notes !== existing.notes) {
      patch.notes = item.notes
      changed = true
    }
    if (item.status && item.status !== existing.status) {
      patch.status = item.status
      changed = true
    }
  }

  if (existing.accounts.length === 0 && item.accounts?.length) {
    patch.accounts = item.accounts
    changed = true
  }
  if (!existing.account && item.account) {
    patch.account = item.account
    changed = true
  }
  if (!existing.baseUrl && item.baseUrl) {
    patch.baseUrl = item.baseUrl
    changed = true
  }
  if (!existing.keyExpiresAt && item.keyExpiresAt) {
    patch.keyExpiresAt = item.keyExpiresAt
    changed = true
  }
  if (existing.usedBy.length === 0 && item.usedBy?.length) {
    patch.usedBy = item.usedBy
    changed = true
  }
  if (existing.channels.length === 0 && item.channels?.length) {
    patch.channels = item.channels
    changed = true
  }
  if (!existing.verified && item.verified) {
    patch.verified = true
    changed = true
  }

  // Лимиты дополняются по одному полю: у записи может быть задан свой потолок окна, и терять
  // его из-за того, что в файле появилась длительность, нельзя.
  if (item.limits) {
    const merged = { ...existing.limits }
    let limitsChanged = false
    for (const [key, value] of Object.entries(item.limits) as Array<[keyof AiLimits, number | null | undefined]>) {
      if (value == null) continue
      if (merged[key] == null) {
        merged[key] = value
        limitsChanged = true
      }
    }
    if (limitsChanged) {
      patch.limits = merged
      changed = true
    }
  }

  return changed ? patch : null
}

/**
 * Досеять в реестр то, чего в нём ещё нет, и дополнить уже заведённое.
 *
 * Вызывается при каждом открытии хранилища и обычно не делает ничего.
 */
export function seedAiAccess(): SeedResult {
  const result: SeedResult = { created: 0, updated: 0, retired: 0, subscriptions: 0, missingKeys: [] }
  if (!vault.isUnlocked()) return result

  const path = seedPath()
  if (!path) return result

  let file: SeedFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as SeedFile
  } catch {
    return result
  }
  if (!Array.isArray(file.access) || !file.access.length) return result

  let env: Record<string, string> = {}
  if (file.envFile) {
    const envPath = expandHome(file.envFile)
    try {
      env = parseEnvFile(readFileSync(envPath, 'utf8'))
    } catch {
      // Нет доступа к env-файлу — доступы всё равно заводим, просто без ключей.
      env = {}
    }
  }

  // Сначала выбывшие: их место в реестре ничем не оправдано, и держать их до конца засева
  // значит показывать в списке то, чего у владельца нет.
  if (Array.isArray(file.retire) && file.retire.length) {
    const retire = new Set(file.retire.map((r) => r.trim().toLowerCase()))
    for (const a of vault.listAiAccess()) {
      if (retire.has(a.label.trim().toLowerCase())) {
        vault.deleteAiAccess(a.id)
        result.retired++
        continue
      }
      // Выбывший доступ мог успеть стать КАНАЛОМ другой записи — тогда удаление по названию его
      // не достаёт, и он продолжает висеть внутри чужого аккаунта.
      const kept = a.channels.filter((c) => !retire.has(c.label.trim().toLowerCase()))
      if (kept.length !== a.channels.length) {
        vault.updateAiAccess(a.id, { provider: a.provider, channels: kept })
        result.retired++
      }
    }
  }

  const existing = vault.listAiAccess()
  const missing = pickMissing(
    existing.map((a) => a.label),
    file.access
  )

  // Сначала дополняем уже заведённое: новые поля файла (список аккаунтов, окно лимита) иначе
  // никогда не доедут до записи, созданной прошлой версией приложения.
  const byName = new Map(existing.map((a) => [a.label.trim().toLowerCase(), a]))
  for (const item of file.access) {
    const found = byName.get(seedLabel(item).toLowerCase())
    if (!found) continue
    const patch = fillGaps(found, item)
    if (!patch) continue
    vault.updateAiAccess(found.id, patch)
    result.updated++
  }

  if (!missing.length) return result

  const existingSubs = vault.listSubscriptions()
  // Сначала все записи без ссылок, потом связываем: фолбэк может указывать на запись,
  // которой в момент создания ещё нет. В карту сразу кладём и уже заведённое — иначе
  // ссылка «чем заменить» на существующую запись потерялась бы.
  const byLabel = new Map<string, string>(existing.map((a) => [a.label.toLowerCase(), a.id]))

  for (const item of missing) {
    let subscriptionId: string | null = null
    if (item.subscription) {
      const s = item.subscription
      const already = existingSubs.find((x) => x.name.toLowerCase() === s.name.toLowerCase())
      if (already) subscriptionId = already.id
      else {
        const created = vault.createSubscription({
          name: s.name,
          provider: s.provider ?? item.provider,
          category: s.category ?? 'AI',
          amount: s.amount,
          currency: (s.currency ?? 'USD') as never,
          period: s.period ?? 'mo',
          nextRenewal: s.nextRenewal ?? null,
          notes: s.notes ?? null,
          manualRenewal: s.manualRenewal ?? false
        })
        existingSubs.push(created)
        subscriptionId = created.id
        result.subscriptions++
      }
    }

    const apiKey = item.apiKey || (item.apiKeyEnv ? env[item.apiKeyEnv] : undefined)
    if (item.apiKeyEnv && !apiKey) result.missingKeys.push(item.label ?? item.provider)

    const input: AiAccessInput = {
      kind: item.kind ?? 'api',
      provider: item.provider,
      label: item.label,
      account: item.account,
      accounts: item.accounts,
      plan: item.plan,
      status: item.status,
      payment: item.payment,
      thirdParty: item.thirdParty,
      baseUrl: item.baseUrl ?? null,
      // Указатель на место хранения значения: если ключ пришёл из env-файла, так и пишем.
      keyRef: item.keyRef ?? (item.apiKeyEnv ? `${file.envFile ?? 'env'} → ${item.apiKeyEnv}` : null),
      keyExpiresAt: item.keyExpiresAt ?? null,
      usedBy: item.usedBy,
      channels: item.channels,
      verified: item.verified,
      limits: item.limits,
      notes: item.notes ?? null,
      subscriptionId,
      apiKey
    }
    const created = vault.createAiAccess(input)
    byLabel.set(seedLabel(item).toLowerCase(), created.id)
    result.created++
  }

  // Ссылки проставляем только у новых записей: у существующих владелец мог поменять фолбэк
  // руками, и файл не должен это откатывать.
  for (const item of missing) {
    if (!item.fallback) continue
    const id = byLabel.get(seedLabel(item).toLowerCase())
    const target = byLabel.get(item.fallback.toLowerCase())
    if (id && target && id !== target) vault.updateAiAccess(id, { provider: item.provider, fallbackId: target })
  }

  return result
}
