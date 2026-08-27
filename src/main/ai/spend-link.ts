// Связать сервер с платежом за него — сразу, без участия владельца.
//
// Сервер живёт в приложении двумя записями по замыслу: железка в парке (у неё есть цена) и
// регулярный платёж в подписках. Обе несут деньги, и месячный расход складывал их — у владельца
// это давало $85,80 лишних в месяц на трёх парах.
//
// Раньше приложение показывало найденные пары и ждало нажатия. Это неверно: цифра врёт ровно до
// тех пор, пока человек не сделает работу, которую программа уже выполнила, — она ведь пары
// НАШЛА. Поэтому связываем сами, а владельцу оставляем возможность передумать.
//
// Чтобы «передумать» работало, связь ставится РОВНО ОДИН РАЗ на устройство: факт записывается в
// ту же память, что помнит засев (`seed_applied`, вид `devlink`). Разорвал связь — при следующем
// открытии хранилища мы её не восстановим. Без этой памяти приложение спорило бы с владельцем на
// каждом запуске, и переспорить его было бы нечем.

import { findDuplicateSpend } from '../../shared/duplicate-spend'
import type { Subscription, SubscriptionInput } from '../types'
import * as vault from '../vault/vault'

/** Вид памяти: связи «устройство → платёж», поставленные приложением. */
const KIND = 'devlink'

/** Поля подписки без идентификатора — то, что принимает обновление. */
function inputOf(s: Subscription): SubscriptionInput {
  return {
    name: s.name,
    provider: s.provider,
    category: s.category,
    amount: s.amount,
    currency: s.currency,
    period: s.period,
    nextRenewal: s.nextRenewal,
    renewalDay: s.renewalDay,
    notes: s.notes,
    manualRenewal: s.manualRenewal,
    deviceId: s.deviceId
  }
}

export interface SpendLink {
  deviceName: string
  subscriptionName: string
  reason: string
}

/**
 * Что связать. Чистая функция: решение видно целиком, не открывая базу.
 *
 * `linkedBefore` — устройства, которым связь уже ставили. Они пропускаются независимо от того,
 * связаны ли сейчас: связь могли снять руками, и это ответ, а не пропущенная работа.
 */
export function planSpendLinks(
  devices: Array<{ id: string; name: string; provider: string; cost: { amount: number; currency: string; usd: number } }>,
  subs: Subscription[],
  linkedBefore: ReadonlySet<string>
): Array<{ deviceId: string; subscriptionId: string; deviceName: string; subscriptionName: string; reason: string }> {
  return findDuplicateSpend(devices, subs).filter((d) => !linkedBefore.has(d.deviceId))
}

/** Связать найденные пары. Возвращает то, что связали, — для строки в журнале открытия. */
export function linkPaidDevices(): SpendLink[] {
  if (!vault.isUnlocked()) return []
  const subs = vault.listSubscriptions()
  const devices = vault.listDevices().map((d) => ({
    id: d.id,
    name: d.name,
    provider: d.provider,
    cost: d.cost
  }))
  const plan = planSpendLinks(devices, subs, vault.appliedSeedKeys(KIND))
  if (plan.length === 0) return []

  const byId = new Map(subs.map((s) => [s.id, s]))
  const done: SpendLink[] = []
  for (const pair of plan) {
    const sub = byId.get(pair.subscriptionId)
    if (!sub) continue
    vault.updateSubscription(sub.id, { ...inputOf(sub), deviceId: pair.deviceId })
    done.push({ deviceName: pair.deviceName, subscriptionName: pair.subscriptionName, reason: pair.reason })
  }
  // Помечаем ВСЕ запланированные, а не только удавшиеся: пара, у которой подписка исчезла между
  // выборкой и записью, второй попытки не заслуживает — её уже нет.
  vault.rememberSeedKeys(
    KIND,
    plan.map((p) => ({ key: p.deviceId, recordId: p.subscriptionId }))
  )
  return done
}
