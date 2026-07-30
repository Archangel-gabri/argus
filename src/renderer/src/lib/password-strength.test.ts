import { describe, expect, it } from 'vitest'
import {
  checkStrength,
  formatCrackTime,
  masterPasswordPolicyError,
  MIN_PASSWORD_SCORE
} from './password-strength'

describe('мастер-пароль для русскоязычного интерфейса', () => {
  // Английский словарь оценивал эти общеизвестные фразы на 4/4 и пропускал их как «отличные».
  it.each(['один два три', 'пароль один два', 'мама мыла раму', 'одиндватри'])(
    'отклоняет простую русскую фразу: %s',
    async (password) => {
      expect((await checkStrength(password)).score).toBeLessThan(MIN_PASSWORD_SCORE)
    }
  )

  it('не запрещает длинную несводимую к словарной фразу только из-за кириллицы', async () => {
    expect((await checkStrength('Янтарь-47!Квант-Лабиринт')).score).toBeGreaterThanOrEqual(
      MIN_PASSWORD_SCORE
    )
  })

  it('возвращает ту же авторитетную ошибку для main-process проверки', async () => {
    await expect(masterPasswordPolicyError('один два три')).resolves.toBe(
      'Пароль слишком слабый — возьми более редкую фразу из 4 или больше слов'
    )
    await expect(masterPasswordPolicyError('Янтарь-47!Квант-Лабиринт')).resolves.toBeNull()
  })

  it('показывает время перебора по-русски, не из английского словаря zxcvbn', () => {
    expect(formatCrackTime(0.5)).toBe('меньше секунды')
    expect(formatCrackTime(90)).toBe('около 2 минут')
    expect(formatCrackTime(60 * 60 * 24 * 800)).toBe('около 2 лет')
  })
})
