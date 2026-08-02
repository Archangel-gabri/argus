import { describe, it, expect, vi } from 'vitest'
import { disposeDevice, disposalClean, type DeviceDisposalActions } from './device-disposal'

// Регрессия на реальный дефект: удаление устройства закрывало ТОЛЬКО проброс-туннели.
// Терминал, файловая сессия и трансляция продолжали работать по открытым соединениям —
// устройства в списке нет, а доступ к машине есть.
const actions = (over: Partial<DeviceDisposalActions> = {}): DeviceDisposalActions => ({
  closeShells: vi.fn(() => 0),
  closeSftp: vi.fn(() => 0),
  closeForwards: vi.fn(() => 0),
  closeScreens: vi.fn(() => 0),
  ...over
})

describe('disposeDevice', () => {
  it('закрывает ВСЕ четыре вида ресурса, а не только туннели', () => {
    const a = actions()
    disposeDevice('dev-1', a)
    expect(a.closeShells).toHaveBeenCalledWith('dev-1')
    expect(a.closeSftp).toHaveBeenCalledWith('dev-1')
    expect(a.closeForwards).toHaveBeenCalledWith('dev-1')
    expect(a.closeScreens).toHaveBeenCalledWith('dev-1')
  })

  it('отчитывается, сколько чего закрыл', () => {
    const r = disposeDevice(
      'dev-1',
      actions({
        closeShells: () => 2,
        closeSftp: () => 1,
        closeForwards: () => 3,
        closeScreens: () => 1
      })
    )
    expect(r).toEqual({ shells: 2, sftp: 1, forwards: 3, screens: 1, failed: [] })
    expect(disposalClean(r)).toBe(true)
  })

  it('падение одного закрывателя не мешает остальным отозвать доступ', () => {
    const a = actions({
      closeShells: () => {
        throw new Error('соединение уже сломано')
      }
    })
    const r = disposeDevice('dev-1', a)
    // Именно это и было опасно: одна битая сессия не должна оставлять живыми остальные.
    expect(a.closeSftp).toHaveBeenCalled()
    expect(a.closeForwards).toHaveBeenCalled()
    expect(a.closeScreens).toHaveBeenCalled()
    expect(r.failed).toEqual(['shells'])
    expect(disposalClean(r)).toBe(false)
  })

  it('трансляция закрывается ПЕРВОЙ — это самый заметный живой доступ', () => {
    const order: string[] = []
    disposeDevice(
      'dev-1',
      actions({
        closeScreens: () => (order.push('screens'), 0),
        closeShells: () => (order.push('shells'), 0),
        closeSftp: () => (order.push('sftp'), 0),
        closeForwards: () => (order.push('forwards'), 0)
      })
    )
    expect(order[0]).toBe('screens')
    expect(order).toHaveLength(4)
  })

  it('сообщает обо всех упавших видах, а не только о первом', () => {
    const boom = (): number => {
      throw new Error('нет')
    }
    const r = disposeDevice('dev-1', actions({ closeShells: boom, closeScreens: boom }))
    expect(r.failed.sort()).toEqual(['screens', 'shells'])
  })
})
