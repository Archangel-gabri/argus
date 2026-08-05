import { describe, expect, it } from 'vitest'
import { keepVerified } from './ai-accounts-prune'

// Автоимпорт однажды принял вход через Google за учётную запись сервиса и завёл шестнадцать
// «аккаунтов OpenAI» — все почты и телефоны, которыми владелец входил в Google.
describe('какие аккаунты остаются в реестре', () => {
  it('остаются только подтверждённые', () => {
    const kept = keepVerified([
      { email: 'настоящий@example.com', verified: true },
      { email: 'из-браузера@example.com', note: 'найден в браузере' },
      { email: '89858504349' }
    ])
    expect(kept.map((a) => a.email)).toEqual(['настоящий@example.com'])
  })

  it('пустой список остаётся пустым, а полностью подтверждённый — целым', () => {
    expect(keepVerified([])).toEqual([])
    const all = [{ email: 'a@example.com', verified: true }, { email: 'b@example.com', verified: true }]
    expect(keepVerified(all)).toHaveLength(2)
  })

  it('сохранённый пароль сам по себе не делает аккаунт подтверждённым', () => {
    // Пароль лежит в браузере у половины интернета — это не доказательство, что учётка твоя
    // и что она вообще существует.
    expect(keepVerified([{ email: 'x@example.com', hasPassword: true }])).toHaveLength(0)
  })

  it('сохранённый ключ аккаунт защищает: его вписывали руками', () => {
    // Разница с паролем принципиальна. Пароль приезжает из браузера сам, а ключ взять неоткуда
    // — если он в хранилище, его завёл владелец. Пока этой оговорки не было, уборка на каждом
    // открытии хранилища молча стирала ключи, которые восстановить уже нечем.
    const kept = keepVerified([
      { email: 'с-ключом@example.com', hasKey: true },
      { email: 'просто-догадка@example.com' }
    ])
    expect(kept.map((a) => a.email)).toEqual(['с-ключом@example.com'])
  })
})
