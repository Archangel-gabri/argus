// Засев реестра AI-доступов из локального файла.
//
// Тот же приём, что и с флотом (`fleet.local.json`): настоящие данные владельца лежат рядом с
// приложением, в git не попадают, а в код и в репозиторий не уезжают ни ключи, ни почты.
//
// Значения ключей в самом файле держать не обязательно и не нужно: запись может сослаться на
// имя переменной в env-файле (`secrets/env/api-keys.env`, права 600), и Argus прочитает
// значение оттуда при засеве. Так единственная копия ключа остаётся там, где владелец её и
// хранит, а в зашифрованный вольт попадает уже готовое значение.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { AiAccessInput, AiKind, AiLimits, AiPayment, AiStatus } from './types'
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
  plan?: string
  status?: AiStatus
  payment?: AiPayment
  thirdParty?: boolean
  baseUrl?: string
  keyRef?: string
  keyExpiresAt?: string
  usedBy?: string[]
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
  const candidates: string[] = []
  try {
    candidates.push(join(app.getAppPath(), 'ai.local.json'))
  } catch {
    /* app path unavailable */
  }
  candidates.push(join(process.cwd(), 'ai.local.json'))
  return candidates.find((p) => existsSync(p)) ?? null
}

export interface SeedResult {
  created: number
  subscriptions: number
  /** Записи, которым в файле обещан ключ, но взять его негде. */
  missingKeys: string[]
}

/**
 * Засеять реестр, если он пуст.
 *
 * Ровно один раз: непустая таблица означает, что владелец уже что-то завёл руками, и
 * подмешивать к этому файл нельзя — получились бы дубли, которые придётся разбирать вручную.
 */
export function seedAiAccessIfEmpty(): SeedResult {
  const result: SeedResult = { created: 0, subscriptions: 0, missingKeys: [] }
  if (!vault.isUnlocked()) return result
  if (vault.listAiAccess().length > 0) return result

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

  const existingSubs = vault.listSubscriptions()
  // Сначала все записи без ссылок, потом связываем: фолбэк может указывать на запись,
  // которой в момент создания ещё нет.
  const byLabel = new Map<string, string>()

  for (const item of file.access) {
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
      plan: item.plan,
      status: item.status,
      payment: item.payment,
      thirdParty: item.thirdParty,
      baseUrl: item.baseUrl ?? null,
      // Указатель на место хранения значения: если ключ пришёл из env-файла, так и пишем.
      keyRef: item.keyRef ?? (item.apiKeyEnv ? `${file.envFile ?? 'env'} → ${item.apiKeyEnv}` : null),
      keyExpiresAt: item.keyExpiresAt ?? null,
      usedBy: item.usedBy,
      limits: item.limits,
      notes: item.notes ?? null,
      subscriptionId,
      apiKey
    }
    const created = vault.createAiAccess(input)
    byLabel.set((item.label ?? item.provider).toLowerCase(), created.id)
    result.created++
  }

  for (const item of file.access) {
    if (!item.fallback) continue
    const id = byLabel.get((item.label ?? item.provider).toLowerCase())
    const target = byLabel.get(item.fallback.toLowerCase())
    if (id && target && id !== target) vault.updateAiAccess(id, { provider: item.provider, fallbackId: target })
  }

  return result
}
