import { describe, it, expect } from 'vitest'
import { parseEfibootmgr } from './pc'

// Цена ошибки здесь — «машина ушла не в ту систему». Прошивки сплошь и рядом дают записям
// одинаковые имена (два «Linux Boot Manager», два «UEFI OS» — обычное дело на машине с
// несколькими дисками), и различает их только путь к загрузчику. Раньше путь выбрасывался,
// записи становились неразличимыми в списке, и выбор делался наугад.
const REAL_OUTPUT = [
  'BootCurrent: 0001',
  'Timeout: 1 seconds',
  'BootOrder: 0001,0003,0000',
  'Boot0000* Windows Boot Manager\tHD(1,GPT,aaaa)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)',
  'Boot0001* Linux Boot Manager\tHD(1,GPT,bbbb)/File(\\EFI\\systemd\\systemd-bootx64.efi)',
  'Boot0003* Linux Boot Manager\tHD(2,GPT,cccc)/File(\\EFI\\GRUB\\grubx64.efi)'
].join('\n')

describe('parseEfibootmgr', () => {
  it('находит все записи и их идентификаторы', () => {
    const e = parseEfibootmgr(REAL_OUTPUT)
    expect(e.map((x) => x.id)).toEqual(['0000', '0001', '0003'])
  })

  it('ОДНОИМЁННЫЕ записи различимы по пути загрузчика', () => {
    const e = parseEfibootmgr(REAL_OUTPUT)
    const linux = e.filter((x) => x.label.includes('Linux Boot Manager'))
    expect(linux).toHaveLength(2)
    // Главное утверждение: подписи не совпадают, иначе выбор из списка — это лотерея.
    expect(linux[0].label).not.toBe(linux[1].label)
    expect(linux[0].label).toContain('systemd-bootx64.efi')
    expect(linux[1].label).toContain('grubx64.efi')
  })

  it('путь стоит первым — по нему и различают', () => {
    const e = parseEfibootmgr(REAL_OUTPUT)
    expect(e[0].label.startsWith('\\EFI\\Microsoft')).toBe(true)
  })

  it('человеческое имя не теряется', () => {
    const e = parseEfibootmgr(REAL_OUTPUT)
    expect(e[0].label).toContain('Windows Boot Manager')
  })

  it('запись без пути остаётся с одним именем, а не пропадает', () => {
    const e = parseEfibootmgr('Boot0007* Какая-то запись')
    expect(e).toEqual([{ id: '0007', label: 'Какая-то запись' }])
  })

  it('служебные строки записями не считаются', () => {
    const e = parseEfibootmgr('BootCurrent: 0001\nTimeout: 1 seconds\nBootOrder: 0001,0000')
    expect(e).toEqual([])
  })

  it('мусор и пустой ввод не роняют разбор', () => {
    for (const bad of ['', '\0', 'команда не найдена', 'Boot' , 'BootZZZZ* нет']) {
      expect(() => parseEfibootmgr(bad)).not.toThrow()
    }
  })
})
