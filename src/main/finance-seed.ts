// Засев счетов из локального файла.
//
// Устроен как засев подписок, но с одним важным отличием: ОСТАТОК файл не трогает.
//
// Причина в природе данных. У российских банков публичного API для личного счёта нет, поэтому
// остаток там вписывается руками — в самом приложении, в тот момент, когда владелец на него
// смотрит. Файл засева знает, какие счета существуют, но не может знать, сколько на них сейчас
// денег: он писался один раз. Позволить ему переписывать остаток значит откатывать свежую цифру
// к той, что была на момент написания файла, при каждом запуске.
//
// Поэтому файл заводит счета и правит их описание, а деньги остаются за владельцем и за теми
// сервисами, у которых есть ключ.

import { readFileSync } from 'node:fs'
import { findSeedFile } from './seed-file'
import type { BalanceSource, Currency, FinanceAccount, FinanceAccountInput, FinanceKind } from './types'
import * as vault from './vault'

export interface SeedAccount {
  name: string
  kind?: FinanceKind
  institution?: string
  currency?: string
  source?: BalanceSource
  keyRef?: string | null
  notes?: string | null
  /** Остаток задаётся ТОЛЬКО при заведении счёта — как стартовое значение, не как истина. */
  balance?: number | null
}

export interface FinanceSeedFile {
  accounts?: SeedAccount[]
  /** Названия счетов, которых у владельца больше нет. */
  retire?: string[]
}

export interface FinanceSeedPlan {
  create: FinanceAccountInput[]
  update: Array<{ id: string; input: FinanceAccountInput }>
  retire: string[]
}

const key = (name: string): string => name.trim().toLowerCase()

/**
 * Что засев сделает со счетами.
 *
 * Чистая функция: решение видно целиком, не открывая базу. Совпадение — по названию без учёта
 * регистра: идентификаторов в файле нет, его пишет человек.
 */
export function planFinanceSeed(file: FinanceSeedFile, existing: FinanceAccount[]): FinanceSeedPlan {
  const byName = new Map(existing.map((a) => [key(a.name), a]))
  const plan: FinanceSeedPlan = { create: [], update: [], retire: [] }

  const retire = new Set((file.retire ?? []).map(key))
  for (const a of existing) if (retire.has(key(a.name))) plan.retire.push(a.id)

  for (const item of file.accounts ?? []) {
    if (!item.name?.trim() || retire.has(key(item.name))) continue
    const current = byName.get(key(item.name))

    if (!current) {
      plan.create.push({
        name: item.name,
        kind: item.kind ?? 'bank',
        institution: item.institution ?? '',
        currency: (item.currency ?? 'RUB') as Currency,
        source: item.source ?? 'manual',
        balance: item.balance ?? null,
        keyRef: item.keyRef ?? null,
        notes: item.notes ?? null
      })
      continue
    }

    // Остаток и время его снятия сюда не попадают намеренно: файл описывает счёт, а не деньги
    // на нём. Иначе каждый запуск откатывал бы свежую цифру к записанной в файле.
    const input: FinanceAccountInput = {
      name: item.name,
      kind: item.kind ?? current.kind,
      institution: item.institution ?? current.institution,
      currency: (item.currency ?? current.currency) as Currency,
      source: item.source ?? current.source,
      keyRef: item.keyRef ?? current.keyRef,
      notes: item.notes ?? current.notes
    }
    const same =
      current.kind === input.kind &&
      current.institution === input.institution &&
      current.currency === input.currency &&
      current.source === input.source &&
      (current.keyRef ?? null) === (input.keyRef ?? null) &&
      (current.notes ?? null) === (input.notes ?? null)
    if (!same) plan.update.push({ id: current.id, input })
  }
  return plan
}

export interface FinanceSeedResult {
  created: number
  updated: number
  retired: number
}

export function seedFinanceAccounts(): FinanceSeedResult {
  const result: FinanceSeedResult = { created: 0, updated: 0, retired: 0 }
  if (!vault.isUnlocked()) return result

  const path = findSeedFile('finance.local.json')
  if (!path) return result

  let file: FinanceSeedFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as FinanceSeedFile
  } catch {
    // Испорченный файл засева не должен мешать приложению открыться.
    return result
  }

  const plan = planFinanceSeed(file, vault.listFinanceAccounts())
  for (const id of plan.retire) {
    vault.deleteFinanceAccount(id)
    result.retired++
  }
  for (const input of plan.create) {
    vault.createFinanceAccount(input)
    result.created++
  }
  for (const { id, input } of plan.update) {
    vault.updateFinanceAccount(id, input)
    result.updated++
  }
  return result
}
