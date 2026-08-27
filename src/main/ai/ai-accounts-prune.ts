// Уборка аккаунтов, которых у владельца нет.
//
// Автоимпорт паролей однажды принял вход через Google за учётную запись сервиса и завёл
// шестнадцать «аккаунтов OpenAI» — все почты, которыми владелец когда-либо входил в Google,
// включая номера телефонов. Причина закрыта в самом импорте, но записи уже лежат в хранилище,
// и убрать их надо явно.
//
// Правило одно: остаются подтверждённые. Подтверждение — это вход в браузере, ответивший ключ
// или прямое слово владельца; всё остальное — догадка, которой в реестре доступов не место.

import * as vault from '../vault/vault'
import type { AiAccountEntry } from '../types'

/**
 * Какие аккаунты записи остаются. Чистая функция — решение видно без хранилища.
 *
 * Сохранённый API-ключ приравнивается к подтверждению. Ключ не берётся из браузера и не
 * появляется сам: если он лежит в хранилище, его вписал владелец — это ровно то «прямое слово»,
 * о котором говорит правило. Без этой оговорки уборка, идущая на каждом открытии хранилища,
 * молча стирала вручную заведённые ключи, восстановить которые неоткуда.
 */
export function keepVerified(accounts: AiAccountEntry[]): AiAccountEntry[] {
  return accounts.filter((a) => a.verified || a.hasKey)
}

export interface PruneResult {
  /** Сколько аккаунтов убрали. */
  removed: number
  /** Из скольких записей. */
  touched: number
}

/**
 * Убрать неподтверждённые аккаунты из всех записей.
 *
 * Пароль убранного стирается тем же движением: хранить пароль от учётки, которой нет в реестре,
 * незачем, а сам пароль всё равно остаётся в браузере. Ключ так не стирается никогда — аккаунт
 * с сохранённым ключом уборка вообще не трогает (см. keepVerified).
 */
export function pruneUnverifiedAccounts(): PruneResult {
  const result: PruneResult = { removed: 0, touched: 0 }
  if (!vault.isUnlocked()) return result

  for (const access of vault.listAiAccess()) {
    if (access.accounts.length === 0) continue
    const kept = keepVerified(access.accounts)
    if (kept.length === access.accounts.length) continue

    const keptEmails = new Set(kept.map((a) => a.email))
    for (const gone of access.accounts.filter((a) => !keptEmails.has(a.email))) {
      // Трогаем хранилище только когда есть что стирать: setAccountSecret — это UPSERT, и на
      // аккаунте без секретов он СОЗДАВАЛ пустую строку. Уборка идёт на каждом открытии
      // хранилища, так что этот мусор копился бы бесконечно.
      if (gone.hasPassword) vault.setAccountSecret(access.id, gone.email, { password: '' })
      result.removed++
    }
    vault.updateAiAccess(access.id, { provider: access.provider, accounts: kept })
    result.touched++
  }
  return result
}
