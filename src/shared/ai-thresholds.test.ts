// Сторож (src/main/alerts.ts) пока не импортирует общие пороги — его перевод на shared не
// укладывается в одну строку и ждёт отдельного захода. До тех пор равенство значений держит
// этот тест, а не структура кода: экран и уведомления обязаны срабатывать на одних числах,
// иначе уведомление уже горит, а экран ещё говорит «всё в порядке». Когда alerts.ts начнёт
// импортировать из shared, тест станет тривиальным — убрать его вместе с дублем.
import { describe, expect, it } from 'vitest'
import * as alerts from '../main/support/alerts'
import * as shared from './ai-thresholds'

const NAMES = [
  'CREDIT_WARNING_USD',
  'CREDIT_CRITICAL_USD',
  'KEY_EXPIRY_WARNING_DAYS',
  'KEY_EXPIRY_CRITICAL_DAYS',
  'IDLE_ACCESS_DAYS'
] as const

describe('пороги ИИ-доступов', () => {
  it('сторож и общий модуль согласны в каждом пороге', () => {
    for (const name of NAMES) expect(alerts[name], name).toBe(shared[name])
  })
})
