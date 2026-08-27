// Разбор богатого Windows-зонда. Живой Windows под рукой есть не всегда, поэтому проверяем на
// образцах ответа — как и разборщики macOS/FreeBSD.
//
// Предмет проверки один: PowerShell отдаёт `$null` там, где счётчика не было, и это НЕ ноль.
// Признак «не измерено» был доведён до конца только у диска, а загрузка и сеть схлопывались в
// ноль ещё в разборе. Счётчики `Win32_PerfFormattedData_*` отваливаются не так редко (их ломает
// повреждённый реестр производительности), и машина показывала «CPU 0%, сеть 0 Б/с» как факт —
// эти нули уезжали и в карточку, и в историю метрик.
import { describe, it, expect } from 'vitest'
import { parseWinV2 } from './pc'

const probe = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    cpu: 17,
    cores: [12, 22],
    ramUsedGb: 12.5,
    ramTotalGb: 32,
    swapUsedGb: 1,
    swapTotGb: 8,
    netRx: 145000,
    netTx: 22000,
    diskR: 1048576,
    diskW: 524288,
    diskPct: 61,
    uptimeSec: 90000,
    mounts: [],
    top: [],
    ...over
  })

describe('parseWinV2', () => {
  it('исправный ответ разбирается целиком', () => {
    const r = parseWinV2(probe())
    expect(r?.cpu).toBe(17)
    expect(r?.metrics.cpuAvailable).toBe(true)
    expect(r?.metrics.netAvailable).toBe(true)
    expect(r?.metrics.diskIoAvailable).toBe(true)
    expect(r?.netRx).toBe(145000)
    expect(r?.uptime).toBe(90000)
  })

  it('$null у загрузки — это «не измерено», а не ноль процентов', () => {
    const r = parseWinV2(probe({ cpu: null }))
    expect(r?.metrics.cpuAvailable).toBe(false)
    // Наружу не уходит выдуманное значение: карточке нужно показать «—», а не «0%».
    expect(r?.cpu).toBeUndefined()
  })

  it('$null у сети не превращается в «тишину на канале»', () => {
    const r = parseWinV2(probe({ netRx: null, netTx: null }))
    expect(r?.metrics.netAvailable).toBe(false)
    expect(r?.netRx).toBeUndefined()
    expect(r?.netTx).toBeUndefined()
  })

  it('отсутствие счётчиков диска по-прежнему видно отдельно', () => {
    const r = parseWinV2(probe({ diskR: null, diskW: null }))
    expect(r?.metrics.diskIoAvailable).toBe(false)
    // Остальные счётчики при этом исправны — признаки независимы.
    expect(r?.metrics.cpuAvailable).toBe(true)
  })

  it('строка не-JSON не роняет разбор', () => {
    expect(parseWinV2('At line:1 char:1\n+ Get-Counter\n')).toBeNull()
    expect(parseWinV2('{ это не json }')).toBeNull()
  })
})
