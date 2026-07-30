import { describe, expect, it } from 'vitest'
import { parseProbeHostOutput } from './ssh-probe'

describe('SSH discovery probe', () => {
  it('разбирает реальные POSIX-маркеры', () => {
    expect(
      parseProbeHostOutput(`ARGUS_OS=Arch Linux
ARGUS_HOST=castiel-pc
ARGUS_CORES=16
ARGUS_LOAD=4.0
ARGUS_MEMTOTAL=32768
ARGUS_MEMUSED=8192`)
    ).toEqual({
      os: 'Arch Linux',
      hostname: 'castiel-pc',
      cores: 16,
      cpu: 25,
      ramTotal: 32,
      ramUsed: 8
    })
  })

  it('разбирает Windows JSON без локализованных имён полей', () => {
    const json = JSON.stringify({
      os: 'Microsoft Windows 11 Pro',
      hostname: 'CASTIEL',
      cores: 16,
      ramTotalMb: 32768,
      ramFreeMb: 12288
    })
    expect(parseProbeHostOutput(`ARGUS_WINDOWS=${json}`)).toEqual({
      os: 'Microsoft Windows 11 Pro',
      hostname: 'CASTIEL',
      cores: 16,
      ramTotal: 32,
      ramUsed: 20
    })
  })

  it('не выдаёт PowerShell/shell ошибку за успешные нулевые метрики', () => {
    expect(parseProbeHostOutput('ParserError: Unexpected token /etc/os-release')).toBeNull()
    expect(parseProbeHostOutput('ARGUS_OS=\nARGUS_HOST=')).toBeNull()
  })
})
