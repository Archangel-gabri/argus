import type { AiAccount, AiCheck } from '@/types'

export interface AiSummary {
  /** null = ещё нет достаточных данных, строка = подтверждённые / проверенные ключи. */
  workingKeys: string | null
  /** null = общий остаток неизвестен хотя бы для одного сохранённого OpenRouter-ключа. */
  totalCredit: number | null
}

export function aiSummary(accounts: AiAccount[], checks: Record<string, AiCheck>): AiSummary {
  const checked = accounts.filter((account) => {
    if (!account.hasKey) return false
    const status = checks[account.id]?.status
    return status === 'valid' || status === 'invalid' || status === 'quota'
  })
  const working = checked.filter((account) => {
    const status = checks[account.id]?.status
    return status === 'valid' || status === 'quota'
  }).length

  const creditAccounts = accounts.filter(
    (account) => account.hasKey && account.provider.toLowerCase().includes('openrouter')
  )
  const knownCredit = creditAccounts.map((account) => checks[account.id]?.remaining)
  const totalCredit =
    knownCredit.length > 0 && knownCredit.every((value): value is number => typeof value === 'number')
      ? knownCredit.reduce((sum, value) => sum + value, 0)
      : null

  return {
    workingKeys: checked.length > 0 ? `${working}/${checked.length}` : null,
    totalCredit
  }
}

export function providerChangeError(current: string, next: string, newKey: string): string | null {
  if (current !== next && !newKey.trim()) return 'При смене провайдера введи ключ для нового сервиса'
  return null
}
