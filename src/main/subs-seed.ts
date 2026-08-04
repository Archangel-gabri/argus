// Засев подписок из локального файла.
//
// Тот же приём, что с флотом и реестром ИИ: настоящие цифры владельца лежат рядом с приложением,
// в git не попадают, а вводить два десятка сумм руками — работа, которую никто не делает.
//
// Отличие от засева ИИ-доступов одно, но важное: файл подписок ОБНОВЛЯЕТ уже заведённые записи.
// Подписка — это не инвентарь, а деньги: сумма растёт, дата продления уезжает, карта отбивается.
// Запись, заведённая полгода назад и с тех пор не тронутая, не «сохранена» — она устарела и врёт.
//
// Обновляются только те поля, которые в файле названы. Поле, которого в файле нет, остаётся как
// есть: иначе засев затирал бы правки, сделанные руками в самом приложении.

import { readFileSync } from 'node:fs'
import { findSeedFile } from './seed-file'
import type { Currency, Subscription, SubscriptionInput } from './types'
import * as vault from './vault'

export interface SeedSubscription {
  name: string
  provider?: string
  category?: string
  amount?: number
  currency?: string
  period?: 'mo' | 'yr'
  nextRenewal?: string | null
  manualRenewal?: boolean
  notes?: string | null
}

export interface SubsSeedFile {
  subscriptions?: SeedSubscription[]
  /** Названия подписок, которых у владельца больше нет. */
  retire?: string[]
}

export interface SubsSeedPlan {
  create: SubscriptionInput[]
  update: Array<{ id: string; input: SubscriptionInput }>
  retire: string[]
}

const key = (name: string): string => name.trim().toLowerCase()

/** Собрать запись для хранилища: поля файла поверх того, что уже лежит. */
function merge(item: SeedSubscription, current?: Subscription): SubscriptionInput {
  return {
    name: item.name,
    provider: item.provider ?? current?.provider ?? '',
    category: item.category ?? current?.category ?? 'Other',
    amount: item.amount ?? current?.amount ?? 0,
    currency: (item.currency ?? current?.currency ?? 'USD') as Currency,
    period: item.period ?? current?.period ?? 'mo',
    nextRenewal: item.nextRenewal !== undefined ? item.nextRenewal : (current?.nextRenewal ?? null),
    notes: item.notes !== undefined ? item.notes : (current?.notes ?? null),
    manualRenewal: item.manualRenewal ?? current?.manualRenewal ?? false
  }
}

/**
 * Что засев сделает с хранилищем.
 *
 * Чистая функция: решение видно целиком, не открывая базу. Совпадение ищется по названию без
 * учёта регистра — идентификаторов у подписок в файле нет и быть не может, файл пишет человек.
 *
 * Запись, ничем не отличающаяся от файла, в план не попадает: лишняя запись в базу — это лишнее
 * событие «данные изменились» на каждом запуске.
 */
export function planSubsSeed(file: SubsSeedFile, existing: Subscription[]): SubsSeedPlan {
  const byName = new Map(existing.map((s) => [key(s.name), s]))
  const plan: SubsSeedPlan = { create: [], update: [], retire: [] }

  const retire = new Set((file.retire ?? []).map(key))
  for (const s of existing) if (retire.has(key(s.name))) plan.retire.push(s.id)

  for (const item of file.subscriptions ?? []) {
    if (!item.name?.trim() || retire.has(key(item.name))) continue
    const current = byName.get(key(item.name))
    const input = merge(item, current)
    if (!current) {
      plan.create.push(input)
      continue
    }
    const same =
      current.provider === input.provider &&
      current.category === input.category &&
      current.amount === input.amount &&
      current.currency === input.currency &&
      current.period === input.period &&
      (current.nextRenewal ?? null) === (input.nextRenewal ?? null) &&
      (current.notes ?? null) === (input.notes ?? null) &&
      current.manualRenewal === input.manualRenewal
    if (!same) plan.update.push({ id: current.id, input })
  }
  return plan
}

function seedPath(): string | null {
  return findSeedFile('subs.local.json')
}

export interface SubsSeedResult {
  created: number
  updated: number
  retired: number
}

export function seedSubscriptions(): SubsSeedResult {
  const result: SubsSeedResult = { created: 0, updated: 0, retired: 0 }
  if (!vault.isUnlocked()) return result

  const path = seedPath()
  if (!path) return result

  let file: SubsSeedFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as SubsSeedFile
  } catch {
    // Испорченный файл засева не должен мешать приложению открыться.
    return result
  }

  const plan = planSubsSeed(file, vault.listSubscriptions())
  for (const id of plan.retire) {
    vault.deleteSubscription(id)
    result.retired++
  }
  for (const input of plan.create) {
    vault.createSubscription(input)
    result.created++
  }
  for (const { id, input } of plan.update) {
    vault.updateSubscription(id, input)
    result.updated++
  }
  return result
}
