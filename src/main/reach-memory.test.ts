import { describe, it, expect, beforeEach } from 'vitest'
import { trackedReach, missesOf, clearReachMemory } from './reach-memory'

// Регрессия на реальный дефект: счётчики промахов жили в модульных картах и переживали
// блокировку. Промах до неё складывался с первым промахом после — и машина объявлялась
// выключенной, хотя в новой сессии её спросили ровно один раз.
describe('trackedReach', () => {
  beforeEach(() => clearReachMemory())

  it('одна неудача — это «не знаю», а не «выключено»', () => {
    // Канал до нод флапает: примерно один опрос из шести промахивается на живой машине.
    expect(trackedReach('probe', 'node-1', 'offline')).toBe('unknown')
  })

  it('выключенной машина считается со второго промаха подряд', () => {
    trackedReach('probe', 'node-1', 'offline')
    expect(trackedReach('probe', 'node-1', 'offline')).toBe('offline')
  })

  it('успех обнуляет серию', () => {
    trackedReach('probe', 'node-1', 'offline')
    expect(trackedReach('probe', 'node-1', 'online')).toBe('online')
    expect(missesOf('probe', 'node-1')).toBe(0)
    // После успеха счёт снова с нуля.
    expect(trackedReach('probe', 'node-1', 'offline')).toBe('unknown')
  })

  it('устройства не влияют друг на друга', () => {
    trackedReach('probe', 'node-1', 'offline')
    expect(trackedReach('probe', 'node-2', 'offline')).toBe('unknown')
  })

  it('два опроса ПК не складывают промахи друг другу', () => {
    // `whichOs` и `pc.metrics` ходят на машину по разным поводам и разными склейками. Пока у
    // них был общий счётчик, один флап канала попадал в оба и давал два промаха: машина
    // объявлялась выключенной с первой осечки — ровно то, что правило запрещает.
    expect(trackedReach('pc-os', 'node-1', 'offline')).toBe('unknown')
    expect(trackedReach('pc-metrics', 'node-1', 'offline')).toBe('unknown')
    expect(missesOf('pc-os', 'node-1')).toBe(1)
    expect(missesOf('pc-metrics', 'node-1')).toBe(1)
  })

  it('быстрая проверка и опрос ПК считаются раздельно', () => {
    trackedReach('probe', 'node-1', 'offline')
    // Тот же идентификатор, другой вид проверки — своя серия.
    expect(trackedReach('pc-metrics', 'node-1', 'offline')).toBe('unknown')
    expect(missesOf('probe', 'node-1')).toBe(1)
    expect(missesOf('pc-metrics', 'node-1')).toBe(1)
  })

  it('блокировка стирает серии — новая сессия начинает с чистого листа', () => {
    trackedReach('probe', 'node-1', 'offline')
    trackedReach('pc-metrics', 'node-1', 'offline')
    expect(missesOf('probe', 'node-1')).toBe(1)

    clearReachMemory()

    expect(missesOf('probe', 'node-1')).toBe(0)
    expect(missesOf('pc-metrics', 'node-1')).toBe(0)
    // Главное: первый промах после разблокировки — снова «не знаю», а не «выключено».
    expect(trackedReach('probe', 'node-1', 'offline')).toBe('unknown')
  })
})
