import { describe, expect, it } from 'vitest'
import { renewalAnchorDay, advanceRenewal, daysUntilCalendar, renewalLabel } from './billing'

describe('календарь продлений', () => {
  it('считает дату по местному календному дню, а не по 24 часам', () => {
    const oneAtNight = new Date(2026, 6, 31, 1, 0, 0).getTime()
    expect(daysUntilCalendar('2026-07-31', oneAtNight)).toBe(0)
    expect(daysUntilCalendar('2026-08-01', oneAtNight)).toBe(1)
  })

  it('не нормализует несуществующую дату в следующий месяц', () => {
    expect(daysUntilCalendar('2026-02-30', Date.now())).toBeNull()
    expect(daysUntilCalendar('когда-нибудь', Date.now())).toBeNull()
  })

  it('различает будущее, сегодня и просрочку', () => {
    expect(renewalLabel(3)).toBe('через 3 дн.')
    expect(renewalLabel(0)).toBe('сегодня')
    expect(renewalLabel(-5)).toBe('просрочено 5 дн.')
  })

  it('зажимает 31-е число к концу короткого месяца', () => {
    expect(advanceRenewal('2026-01-31', 'mo', new Date(2026, 0, 31).getTime())).toBe('2026-02-28')
    expect(advanceRenewal('2024-01-31', 'mo', new Date(2024, 0, 31).getTime())).toBe('2024-02-29')
  })

  it('не теряет исходное 31-е число при давной просрочке', () => {
    expect(advanceRenewal('2026-01-31', 'mo', new Date(2026, 2, 3).getTime())).toBe('2026-03-31')
  })

  it('для будущего платежа всё равно сдвигает ровно на период', () => {
    expect(advanceRenewal('2026-08-15', 'mo', new Date(2026, 6, 30).getTime())).toBe('2026-09-15')
    expect(advanceRenewal('2024-02-29', 'yr', new Date(2024, 1, 29).getTime())).toBe('2025-02-28')
  })
})

describe('день-якорь списания', () => {
  it('короткий месяц не крадёт 31-е число навсегда', () => {
    // Реальный сценарий: подписка списывается 31-го, человек каждый месяц жмёт «Продлено».
    // Пока результат сохранялся как новый якорь, февраль зажимал дату на 28-е — и дальше она
    // оставалась 28-м навсегда. Списание приходило на три дня позже напоминания, каждый месяц.
    const anchorDay = 31
    let stored = '2026-01-31'
    const seen: string[] = [stored]
    for (const today of ['2026-01-31', '2026-02-28', '2026-03-28', '2026-04-28']) {
      stored = advanceRenewal(stored, 'mo', Date.parse(`${today}T12:00:00`), anchorDay)!
      seen.push(stored)
    }
    expect(seen).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
  })

  it('без якоря поведение прежнее — считаем от самой даты', () => {
    expect(advanceRenewal('2026-01-15', 'mo', Date.parse('2026-01-20T12:00:00'))).toBe('2026-02-15')
  })

  it('якорь вычисляется из первой известной даты', () => {
    expect(renewalAnchorDay('2026-01-31')).toBe(31)
    expect(renewalAnchorDay(null)).toBeNull()
    expect(renewalAnchorDay('не дата')).toBeNull()
  })
})
