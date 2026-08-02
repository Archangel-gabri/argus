import { describe, it, expect } from 'vitest'
import { resolvePowerAction, describeRejectedAction } from './power-action'

// Регрессия на реальный дефект: обработчик `pc:power` сводил любое неузнанное действие
// к перезагрузке. Ниже — именно те значения, которые раньше уводили живую машину в ребут.
describe('resolvePowerAction', () => {
  it('пропускает три известных действия без изменений', () => {
    expect(resolvePowerAction('reboot')).toBe('reboot')
    expect(resolvePowerAction('poweroff')).toBe('poweroff')
    expect(resolvePowerAction('suspend')).toBe('suspend')
  })

  it('НЕ превращает неизвестное действие в перезагрузку', () => {
    // Каждое из этих значений раньше означало «перезагрузить чужой сервер».
    for (const bad of ['shutdown', 'halt', 'Reboot', 'REBOOT', ' reboot', 'reboot ', '']) {
      expect(resolvePowerAction(bad)).toBeNull()
    }
  })

  it('отвергает всё, что вообще не строка', () => {
    for (const bad of [null, undefined, 0, 1, true, {}, [], { action: 'reboot' }]) {
      expect(resolvePowerAction(bad)).toBeNull()
    }
  })

  it('не угадывает «почти правильное»', () => {
    // Соблазн сделать trim+toLowerCase велик, но тогда опечатка в вызывающем коде
    // молча продолжит работать, и дефект вернётся в другой форме.
    expect(resolvePowerAction('Suspend')).toBeNull()
    expect(resolvePowerAction('power-off')).toBeNull()
    expect(resolvePowerAction('poweroff\n')).toBeNull()
  })
})

describe('describeRejectedAction', () => {
  it('называет пустую строку словами, а не пустотой', () => {
    expect(describeRejectedAction('')).toBe('пустая строка')
  })

  it('показывает тип, когда пришла не строка', () => {
    expect(describeRejectedAction(null)).toBe('object')
    expect(describeRejectedAction(42)).toBe('number')
  })

  it('обрезает длинный мусор, чтобы он не уехал целиком в сообщение', () => {
    expect(describeRejectedAction('x'.repeat(200))).toHaveLength(42)
  })
})
