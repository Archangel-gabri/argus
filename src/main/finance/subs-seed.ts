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
import { findSeedFile } from '../vault/seed-file'
import type { Currency, Subscription, SubscriptionInput } from '../types'
import * as vault from '../vault/vault'

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

/** Что запомнить о применённой записи: сам ключ и, когда известен, идентификатор строки. */
export type SeededKey = string | { key: string; recordId: string }

/** Ключ памяти засева в строковом виде — им сверяются с `appliedSeedKeys`. */
export const seededKeyOf = (s: SeededKey): string => (typeof s === 'string' ? s : s.key)

export interface SubsSeedPlan {
  create: SubscriptionInput[]
  update: Array<{ id: string; input: SubscriptionInput }>
  retire: string[]
  /** Что после применения плана надо запомнить как принесённое: ключ и, если знаем, запись. */
  seeded: SeededKey[]
}

const key = (name: string): string => name.trim().toLowerCase()

/** Вид засева в памяти применённого — у подписок, счетов и ИИ-доступов свои пространства имён. */
const SEED_KIND = 'subs'

/**
 * Какая дата продления победит.
 *
 * `undefined` в файле означает «не сказано» — остаётся то, что в базе. Явный `null` стирает.
 * Во всех остальных случаях берётся ПОЗДНЕЙШАЯ: файл писался однажды и не знает про продления,
 * случившиеся после.
 */
export function laterRenewal(fromFile: string | null | undefined, current: string | null): string | null {
  if (fromFile === undefined) return current
  if (fromFile === null) return null
  if (!current) return fromFile
  return current > fromFile ? current : fromFile
}


/** Собрать запись для хранилища: поля файла поверх того, что уже лежит. */
function merge(item: SeedSubscription, current?: Subscription): SubscriptionInput {
  return {
    name: item.name,
    provider: item.provider ?? current?.provider ?? '',
    category: item.category ?? current?.category ?? 'Other',
    amount: item.amount ?? current?.amount ?? 0,
    currency: (item.currency ?? current?.currency ?? 'USD') as Currency,
    period: item.period ?? current?.period ?? 'mo',
    // Дата продления — единственное поле, где файл НЕ главный. Кнопка «Продлено» двигает её
    // вперёд на оплаченный период, и если файл вернёт свою — сторож снова скажет «срок прошёл»,
    // а нажатие окажется бесполезным. Поэтому файл задаёт дату как «не раньше чем»: более
    // поздняя дата в базе выигрывает.
    nextRenewal: laterRenewal(item.nextRenewal, current?.nextRenewal ?? null),
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
export function planSubsSeed(
  file: SubsSeedFile,
  existing: Subscription[],
  alreadySeeded: ReadonlySet<string> = new Set(),
  seededRecords: ReadonlyMap<string, string> = new Map()
): SubsSeedPlan {
  const byName = new Map(existing.map((s) => [key(s.name), s]))
  const byId = new Map(existing.map((s) => [s.id, s]))
  const plan: SubsSeedPlan = { create: [], update: [], retire: [], seeded: [] }

  const retire = new Set((file.retire ?? []).map(key))
  for (const s of existing) if (retire.has(key(s.name))) plan.retire.push(s.id)

  for (const item of file.subscriptions ?? []) {
    if (!item.name?.trim() || retire.has(key(item.name))) continue
    // Свою запись ищем СНАЧАЛА по идентификатору, и только потом по имени. Имя — не
    // идентичность: владелец переименовывает подписку в приложении, а название уточняют и в
    // самом файле. По имени такая запись не находилась, и засев заводил вторую — обе попадали
    // в месячный расход.
    const k = key(item.name)
    const current = (seededRecords.has(k) ? byId.get(seededRecords.get(k)!) : undefined) ?? byName.get(k)
    const input = merge(item, current)
    // Ключ помечается принесённым, ЕСТЬ запись в хранилище или нет.
    //
    // Иначе память засева не наполняется у того, у кого хранилище уже заполнено прежними
    // запусками: имена совпадают, план идёт в «обновить» или «ничего не делать», ключ не
    // запоминается — и первое же удаление воскрешает запись ровно один раз на каждую. Выглядит
    // это как «иногда возвращается», то есть хуже честной поломки.
    plan.seeded.push(current ? { key: k, recordId: current.id } : k)
    if (!current) {
      // Запись из файла, которой в хранилище нет. Заводим её ОДИН раз: если этот ключ уже
      // приносили, значит владелец её удалил (или переименовал) — и повторное создание
      // отменяло бы его решение на каждом входе.
      if (alreadySeeded.has(key(item.name))) continue
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

  const plan = planSubsSeed(
    file,
    vault.listSubscriptions(),
    vault.appliedSeedKeys(SEED_KIND),
    vault.appliedSeedRecords(SEED_KIND)
  )
  // План применяется целиком или никак. Иначе одна кривая строка в файле (неизвестная валюта,
  // сумма строкой, несуществующая дата) роняла засев в середине — уже с выполненными
  // удалениями и половиной созданных записей, причём молча: выше стоит общий catch.
  vault.atomically(() => {
    for (const id of plan.retire) {
      vault.deleteSubscription(id)
      result.retired++
    }
    for (const input of plan.create) {
      // Идентификатор созданной записи запоминаем сразу: он и есть её идентичность, а имя
      // может измениться уже завтра.
      const created = vault.createSubscription(input)
      plan.seeded.push({ key: key(input.name), recordId: created.id })
      result.created++
    }
    for (const { id, input } of plan.update) {
      vault.updateSubscription(id, input)
      result.updated++
    }
    vault.rememberSeedKeys(SEED_KIND, plan.seeded)
  })
  return result
}
