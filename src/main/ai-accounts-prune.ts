// Уборка аккаунтов, которых у владельца нет.
//
// Автоимпорт паролей однажды принял вход через Google за учётную запись сервиса и завёл
// шестнадцать «аккаунтов OpenAI» — все почты, которыми владелец когда-либо входил в Google,
// включая номера телефонов. Причина закрыта в самом импорте, но записи уже лежат в хранилище,
// и убрать их надо явно.
//
// Правило одно: остаются подтверждённые. Подтверждение — это вход в браузере, ответивший ключ
// или прямое слово владельца; всё остальное — догадка, которой в реестре доступов не место.

import * as vault from './vault'
import type { AiAccountEntry } from './types'

/** Какие аккаунты записи остаются. Чистая функция — решение видно без хранилища. */
export function keepVerified(accounts: AiAccountEntry[]): AiAccountEntry[] {
  return accounts.filter((a) => a.verified)
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
 * Секреты убранных стираются тем же движением: хранить пароль от учётки, которой нет в реестре,
 * незачем, а сам пароль всё равно остаётся в браузере.
 */
export function pruneUnverifiedAccounts(): PruneResult {
  const result: PruneResult = { removed: 0, touched: 0 }
  if (!vault.isUnlocked()) return result

  for (const access of vault.listAiAccess()) {
    if (access.accounts.length === 0) continue
    const kept = keepVerified(access.accounts)
    if (kept.length === access.accounts.length) continue

    for (const gone of access.accounts.filter((a) => !a.verified)) {
      vault.setAccountSecret(access.id, gone.email, { password: '', apiKey: '' })
      result.removed++
    }
    vault.updateAiAccess(access.id, { provider: access.provider, accounts: kept })
    result.touched++
  }
  return result
}
