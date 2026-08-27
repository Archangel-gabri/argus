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
    const family = providerFamily(a.provider)
    // «other» — это не семья провайдеров, а признание, что семьи нет: под ним стоят Cursor,
    // Brave Search и всё прочее, у чего своего провайдера в справочнике не заведено. Слить их по
    // общей почте владельца значит объявить разные сервисы одним аккаунтом — так ChatInfo.ru
    // однажды стал «каналом» Cursor.
    //
    // Без почты аккаунт тоже не опознать — такая запись остаётся сама по себе.
    const key = email && family !== 'other' ? `${family}|${email}` : `single|${a.id}`
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
      // Имя записи — название сервиса, а не почта. Почта опознаёт аккаунт, но не называет его:
      // в списке из трёх записей с одной почтой владельца получались три одинаковые строки
      // «очень-длинная-почта@g…», по которым не выбрать нужную. Почта показывается отдельной строкой.
      label: head.label || head.account,
      channels,
      dropIds: sorted.slice(1).map((a) => a.id),
      verified: sorted.some((a) => a.verified || a.accounts.some((acc) => acc.verified))
    })
  }
  return plans
}

/** Выполнить слияние в хранилище. Возвращает, сколько аккаунтов получилось и сколько записей ушло. */
/**
 * Вернуть записи название сервиса вместо почты.
 *
 * Первая версия слияния переименовывала запись в почту владельца, и список превращался в столбик
 * одинаковых строк. Настоящее название при этом никуда не делось — оно уехало в канал, откуда его
 * и берём. Чистая функция: `null` означает «эту запись трогать не надо».
 */
export function repairLabel(access: Pick<AiAccess, 'label' | 'account' | 'channels'>): string | null {
  const email = access.account.trim().toLowerCase()
  if (!email || access.label.trim().toLowerCase() !== email) return null
  const named = access.channels.find((c) => c.label.trim().toLowerCase() !== email && c.label.trim())
  return named ? named.label : null
}

/** Вид памяти о переходах: тот же механизм, что помнит засев и связи «сервер ↔ платёж». */
const MIGRATION_KIND = 'migration'

export function migrateToAccounts(): { accounts: number; merged: number } {
  if (!vault.isUnlocked()) return { accounts: 0, merged: 0 }
  const list = vault.listAiAccess()

  // Записи, переименованные прошлой версией слияния в почту, чинятся при любом запуске: переход
  // у них уже состоялся, и без этого они остались бы столбиком одинаковых строк навсегда.
  for (const a of list) {
    const name = repairLabel(a)
    if (name) vault.updateAiAccess(a.id, { provider: a.provider, label: name })
  }

  // Переход — одноразовый, и помнить о нём надо ОТДЕЛЬНО, а не выводить из состояния данных.
  //
  // Признак «у всех записей есть каналы» для этого не годится: форма создаёт запись с пустым
  // списком каналов, то есть любая заведённая руками запись возвращала слияние к жизни. Дальше
  // оно складывало её с записью того же провайдера и на следующем входе УДАЛЯЛО — вместе с
  // вписанными лимитами, заметками, привязкой к подписке и сроком ключа. Тот же класс дефекта,
  // что уже дважды чинили уровнем ниже, у аккаунтов.
  //
  // Побочный эффект был не менее скверным: удаление ПОСЛЕДНЕГО канала откатывалось само —
  // следующий вход воссоздавал автоканал, и удаление выглядело не работающим.
  const MIGRATION_KEY = 'channels-merged'
  if (vault.appliedSeedKeys(MIGRATION_KIND).has(MIGRATION_KEY)) return { accounts: 0, merged: 0 }
  if (list.length === 0) {
    vault.rememberSeedKeys(MIGRATION_KIND, [MIGRATION_KEY])
    return { accounts: 0, merged: 0 }
  }

  const plans = planMerge(list)
  let merged = 0
  for (const plan of plans) {
    // Ключ поглощаемой записи надо забрать ДО удаления. Иначе выходит так: у подписки ChatGPT
    // ключа нет, у записи «ключ API» он есть, после слияния остаётся первая — и ключ уходит
    // вместе со второй. При этом канал продолжает утверждать «ключ сохранён», проверка отвечает
    // «ключа нет», а список моделей молча перестаёт обновляться.
    const keeperKey = vault.getAiKey(plan.keepId)
    const rescued = keeperKey ? null : plan.dropIds.map((id) => vault.getAiKey(id)).find(Boolean) ?? null

    vault.updateAiAccess(plan.keepId, {
      provider: plan.provider,
      label: plan.label,
      channels: plan.channels,
      verified: plan.verified,
      ...(rescued ? { apiKey: rescued } : {})
    })
    for (const id of plan.dropIds) {
      vault.deleteAiAccess(id)
      merged++
    }
  }
  // Помечаем переход состоявшимся независимо от того, было ли что сливать: одноразовость —
  // свойство самого перехода, а не результата.
  vault.rememberSeedKeys(MIGRATION_KIND, [MIGRATION_KEY])
  return { accounts: plans.length, merged }
}
