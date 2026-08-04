// Переход на модель «провайдер → аккаунт → каналы».
//
// Раньше запись реестра означала СПОСОБ доступа: «ChatGPT», «Codex CLI (через роутер)» и «ключ
// OpenAI» стояли рядом как равные. На деле это один аккаунт, у которого три канала, — тариф,
// лимиты и деньги у них общие, и показывать одну квоту трижды неправильно.
//
// Здесь старые записи сливаются: за ключ берётся пара «семья провайдера + почта», а каждая
// исходная запись становится каналом получившегося аккаунта.
//
// Слияние идёт ровно один раз и только для записей, у которых каналов ещё нет: повторный
// прогон ничего не меняет.

import { providerFamily } from '../shared/ai-providers'
import type { AiAccess, AiChannel, AiKind } from './types'
import * as vault from './vault'

/** Во что превращается запись, ставшая каналом. */
export function channelFor(access: AiAccess): AiChannel {
  const label = access.label
  const lower = `${label} ${access.usedBy.join(' ')}`.toLowerCase()

  const kind: AiChannel['kind'] = /codex|claude code|cli|deepcode/.test(lower)
    ? 'cli'
    : access.kind === 'api' || access.kind === 'router' || access.hasKey
      ? 'api'
      : 'web'

  const channel: AiChannel = { kind, label }
  const tool = access.usedBy[0]
  if (tool) channel.tool = tool
  if (access.baseUrl) channel.baseUrl = access.baseUrl
  if (access.thirdParty) channel.thirdParty = true
  if (access.keyRef) channel.keyRef = access.keyRef
  if (access.hasKey) channel.hasKey = true
  return channel
}

/**
 * Какая из сливаемых записей задаёт лицо аккаунта.
 *
 * Побеждает подписка: у неё деньги, тариф и лимиты, то есть всё, чем аккаунт описывается.
 * Дальше — та, у которой известна почта: без неё аккаунт не назвать.
 */
function rank(access: AiAccess): number {
  if (access.kind === 'subscription') return 0
  if (access.account) return 1
  if (access.kind === 'api' || access.kind === 'router') return 2
  return 3
}

export interface MergePlan {
  /** Запись, которая остаётся и становится аккаунтом. */
  keepId: string
  provider: string
  account: string
  kind: AiKind
  label: string
  channels: AiChannel[]
  /** Записи, которые уходят: их содержимое переехало в каналы. */
  dropIds: string[]
  verified: boolean
}

/**
 * Построить план слияния.
 *
 * Чистая функция: её решения можно проверить, не трогая хранилище. Записи без почты не
 * сливаются между собой — у бесплатных тарифов и локальных моделей аккаунта может не быть
 * вовсе, и склеивать их по одному лишь провайдеру значит выдумывать связь.
 */
export function planMerge(list: AiAccess[]): MergePlan[] {
  const groups = new Map<string, AiAccess[]>()
  for (const a of list) {
    const email = a.account.trim().toLowerCase()
    // Без почты аккаунт не опознать — такая запись остаётся сама по себе.
    const key = email ? `${providerFamily(a.provider)}|${email}` : `single|${a.id}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(a)
    else groups.set(key, [a])
  }

  const plans: MergePlan[] = []
  for (const bucket of groups.values()) {
    const sorted = [...bucket].sort((x, y) => rank(x) - rank(y) || x.createdAt - y.createdAt)
    const head = sorted[0]
    const channels = [...head.channels]
    // Канал самой ведущей записи добавляется, только если у неё их ещё нет: иначе повторный
    // прогон продублирует его.
    if (channels.length === 0) channels.push(channelFor(head))
    for (const other of sorted.slice(1)) {
      const own = other.channels.length ? other.channels : [channelFor(other)]
      for (const ch of own) if (!channels.some((c) => c.label === ch.label)) channels.push(ch)
    }

    plans.push({
      keepId: head.id,
      provider: head.provider,
      account: head.account,
      kind: head.kind,
      // Имя аккаунта — почта: именно её ищут, когда открывают провайдера. Название способа
      // доступа переехало в канал.
      label: head.account || head.label,
      channels,
      dropIds: sorted.slice(1).map((a) => a.id),
      verified: sorted.some((a) => a.verified || a.accounts.some((acc) => acc.verified))
    })
  }
  return plans
}

/** Выполнить слияние в хранилище. Возвращает, сколько аккаунтов получилось и сколько записей ушло. */
export function migrateToAccounts(): { accounts: number; merged: number } {
  if (!vault.isUnlocked()) return { accounts: 0, merged: 0 }
  const list = vault.listAiAccess()
  // Каналы уже расставлены — значит переход состоялся.
  if (list.length === 0 || list.every((a) => a.channels.length > 0)) return { accounts: 0, merged: 0 }

  const plans = planMerge(list)
  let merged = 0
  for (const plan of plans) {
    vault.updateAiAccess(plan.keepId, {
      provider: plan.provider,
      label: plan.label,
      channels: plan.channels,
      verified: plan.verified
    })
    for (const id of plan.dropIds) {
      vault.deleteAiAccess(id)
      merged++
    }
  }
  return { accounts: plans.length, merged }
}
