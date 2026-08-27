// Склейка проверяется ПО ЧИСЛУ реальных вызовов, а не по секундомеру: время до удалённого
// сервера скачет в разы, и на таком шуме измерение времени не доказывает ничего.
import { describe, it, expect } from 'vitest'
import { singleFlight, inFlightCount } from './single-flight'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Работа, которая считает, сколько раз её на самом деле выполнили. */
function countingWork(): { work: () => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    work: async () => {
      calls++
      await delay(50)
      return 'результат'
    }
  }
}

describe('singleFlight — склейка одновременных опросов', () => {
  it('пять одновременных запросов по одному ключу = одна работа', async () => {
    const { work, calls } = countingWork()
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => singleFlight('k', work)))
    expect(calls()).toBe(1)
    expect(all.every((r) => r === 'результат')).toBe(true)
  })

  it('разные ключи выполняются раздельно', async () => {
    const { work, calls } = countingWork()
    await Promise.all([singleFlight('a', work), singleFlight('b', work)])
    expect(calls()).toBe(2)
  })

  it('после ответа работа выполняется заново — это склейка, а не кэш', async () => {
    const { work, calls } = countingWork()
    await singleFlight('c', work)
    await singleFlight('c', work)
    expect(calls()).toBe(2)
  })

  // Ошибка не должна оставлять ключ навсегда занятым: иначе одна неудача блокировала бы
  // опрос устройства до перезапуска приложения.
  it('ошибка склеивается, ключ освобождается, следующий запрос проходит', async () => {
    let calls = 0
    const boom = async (): Promise<never> => {
      calls++
      await delay(10)
      throw new Error('сломалось')
    }

    const results = await Promise.allSettled([singleFlight('e', boom), singleFlight('e', boom)])
    expect(calls).toBe(1)
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(inFlightCount()).toBe(0)

    calls = 0
    await singleFlight('e', boom).catch(() => undefined)
    expect(calls).toBe(1)
  })

  it('после всех запросов не осталось незакрытых работ', () => {
    expect(inFlightCount()).toBe(0)
  })
})
