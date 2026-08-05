// Быстрая проверка живости: её вердикт красит карточки всего парка, поэтому цена ошибки —
// «весь парк показывает протухшие статусы как факт».
import { describe, expect, it } from 'vitest'
import { tcpAlive } from './liveness'

describe('tcpAlive', () => {
  it('порт вне диапазона — «не знаю», а не падение', async () => {
    // Регрессия на реальный отказ: Node бросает ERR_SOCKET_BAD_PORT СИНХРОННО, и этот бросок
    // улетал через Promise.all в обработчик IPC, где ловить было уже некому. Обновление
    // статусов парка выключалось до перезапуска приложения, а карточки продолжали показывать
    // последний известный статус — то есть врали с уверенным видом.
    // Сравниваем статус, а не время: замер идёт по часам и на быстрой машине даёт 0 или 1 мс.
    expect((await tcpAlive('127.0.0.1', 70_000, 200)).status).toBe('unknown')
    expect((await tcpAlive('127.0.0.1', -5, 200)).status).toBe('unknown')
    expect((await tcpAlive('127.0.0.1', 1.5, 200)).status).toBe('unknown')
  })

  it('пустой хост и заглушка не проверяются вовсе', async () => {
    expect((await tcpAlive('', 22, 200)).status).toBe('unknown')
    expect((await tcpAlive('10.x.x.1', 22, 200)).status).toBe('unknown')
  })

  it('закрытый порт на локальной машине — «выключено», и проба укладывается в бюджет', async () => {
    const r = await tcpAlive('127.0.0.1', 1, 1000)
    expect(r.status).toBe('offline')
  })
})
