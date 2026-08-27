import { describe, it, expect } from 'vitest'
import { interpretWindowsService, interpretHealth, versionCompatible } from './agent-health'

// Регрессия на два реальных дефекта одного рода: удалённая операция объявлялась успешной
// по коду возврата, хотя код возврата ничего не доказывал.
describe('interpretWindowsService', () => {
  it('успех — только когда и задача, и правило firewall реально существуют', () => {
    const out = 'ARGUS_SVC_TASK=1;ARGUS_SVC_FW=1;ARGUS_SVC_DONE'
    expect(interpretWindowsService(out, true)).toEqual({ ok: true })
  })

  it('нет задачи автозапуска — это провал, даже если exit нулевой', () => {
    // Ровно этот случай и выдавался за успех: не-прерывающий access denied на
    // Register-ScheduledTask, скрипт дошёл до конца и напечатал 'ok'.
    const r = interpretWindowsService('ARGUS_SVC_TASK=0;ARGUS_SVC_FW=1;ARGUS_SVC_DONE', true)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/прав администратора/)
  })

  it('нет правила firewall — тоже провал: агент торчал бы в локальную сеть', () => {
    const r = interpretWindowsService('ARGUS_SVC_TASK=1;ARGUS_SVC_FW=0;ARGUS_SVC_DONE', true)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/локальной сети/)
  })

  it('перехваченная ошибка попадает в текст', () => {
    const r = interpretWindowsService(
      'ARGUS_SVC_ERR=Access is denied;ARGUS_SVC_TASK=0;ARGUS_SVC_FW=0;ARGUS_SVC_DONE',
      true
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Access is denied/)
  })

  it('нет маркера завершения — успехом не считается', () => {
    expect(interpretWindowsService('', true).ok).toBe(false)
    expect(interpretWindowsService('какой-то посторонний вывод', true).ok).toBe(false)
  })
})

describe('versionCompatible', () => {
  it('заплатки протокол не меняют', () => {
    expect(versionCompatible('0.1.3', '0.1.0')).toBe(true)
    expect(versionCompatible('0.1.0', '0.1.0')).toBe(true)
  })

  it('другая минорная или мажорная — несовместимо', () => {
    expect(versionCompatible('0.2.0', '0.1.0')).toBe(false)
    expect(versionCompatible('1.1.0', '0.1.0')).toBe(false)
    expect(versionCompatible('0.0.1', '0.1.0')).toBe(false)
  })

  it('версии нет вовсе — несовместимо', () => {
    expect(versionCompatible(undefined, '0.1.0')).toBe(false)
    expect(versionCompatible('', '0.1.0')).toBe(false)
  })
})

describe('interpretHealth', () => {
  it('свежий агент считается рабочим', () => {
    const r = interpretHealth({ ok: true, version: '0.1.0' }, '0.1.0')
    expect(r.running).toBe(true)
    expect(r.outdated).toBe(false)
  })

  it('НЕСОВМЕСТИМЫЙ агент рабочим не считается', () => {
    // Раньше version просто пересылалась наверх и ни с чем не сверялась: агент старого
    // протокола объявлялся готовым, окно открывалось, и разваливалось всё уже на кадрах.
    const r = interpretHealth({ ok: true, version: '0.0.1' }, '0.1.0')
    expect(r.running).toBe(false)
    expect(r.outdated).toBe(true)
    expect(r.error).toMatch(/переустанови/)
  })

  it('агент без версии — тоже несовместим', () => {
    const r = interpretHealth({ ok: true }, '0.1.0')
    expect(r.running).toBe(false)
    expect(r.outdated).toBe(true)
  })

  it('ok:false — не запущен, и это не про версию', () => {
    const r = interpretHealth({ ok: false, error: 'захват не стартовал' }, '0.1.0')
    expect(r.running).toBe(false)
    expect(r.outdated).toBe(false)
    expect(r.error).toBe('захват не стартовал')
  })
})
