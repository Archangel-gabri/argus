import { describe, it, expect } from 'vitest'
import { buildForgetCommand, decideForgetOutcome } from './agent-forget'

// Регрессия на реальный дефект: «забыть агент» стирал локальный токен первым, службу на
// машине не останавливал вовсе, а при недоступной машине рапортовал успех.
describe('buildForgetCommand', () => {
  it('на Linux останавливает службу ДО удаления ключевого материала', () => {
    const cmd = buildForgetCommand('linux')
    const stop = cmd.indexOf('systemctl --user stop')
    const rm = cmd.indexOf('rm -f "$HOME/.argus/agent.crt"')
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(rm).toBeGreaterThan(stop)
  })

  it('на Linux снимает и автозапуск, иначе агент вернётся после перезагрузки', () => {
    const cmd = buildForgetCommand('linux')
    expect(cmd).toContain('systemctl --user disable argus-agent.service')
    expect(cmd).toContain('rm -f "$HOME/.config/systemd/user/argus-agent.service"')
  })

  it('на Windows снимает задачу планировщика и добивает процесс', () => {
    const cmd = buildForgetCommand('windows')
    expect(cmd).toContain("Stop-ScheduledTask -TaskName 'ArgusAgent'")
    expect(cmd).toContain("Unregister-ScheduledTask -TaskName 'ArgusAgent'")
    expect(cmd).toContain('Stop-Process -Force')
  })

  it('каждая ветка заканчивается ПРОВЕРКОЙ, а не словом «ok»', () => {
    // Именно подстановка «ok» в конец скрипта и делала ложный успех незаметным.
    for (const cmd of [
      buildForgetCommand('linux'),
      buildForgetCommand('windows'),
      buildForgetCommand('darwin', 'gui/501/com.argus.agent')
    ]) {
      expect(cmd).toMatch(/ARGUS_FORGET_(OK|PROC_ALIVE|TASK_ALIVE)/)
    }
  })

  it('на macOS выгружает задание launchd под нужным доменом', () => {
    const cmd = buildForgetCommand('darwin', "gui/501/com.argus.agent'; rm -rf /")
    expect(cmd).toContain('launchctl bootout')
    // Имя задания приходит из внешнего контекста — оно обязано быть заковычено.
    expect(cmd).not.toMatch(/bootout 'gui\/501\/com\.argus\.agent'; rm -rf \//)
  })
})

describe('decideForgetOutcome', () => {
  it('машина не в сети — это НЕ успех', () => {
    const r = decideForgetOutcome({ family: 'off', execOk: false, output: '' })
    expect(r.ok).toBe(false)
    expect(r.revoked).toBe('pending')
    // Человек должен понять, что агент на машине всё ещё живой.
    expect(r.ok === false && r.error).toMatch(/продолжает работать/)
  })

  it('подтверждённый маркер — единственный путь к успеху', () => {
    const r = decideForgetOutcome({ family: 'linux', execOk: true, output: 'ARGUS_FORGET_OK' })
    expect(r).toEqual({ revoked: 'remote', ok: true })
  })

  it('нулевой код возврата без маркера успехом не считается', () => {
    // Почти все шаги намеренно `|| true`, поэтому exit=0 тут не доказывает ничего.
    const r = decideForgetOutcome({ family: 'linux', execOk: true, output: '' })
    expect(r.ok).toBe(false)
    expect(r.revoked).toBe('failed')
  })

  it('живой процесс после отзыва — провал с внятной причиной', () => {
    const r = decideForgetOutcome({ family: 'linux', execOk: true, output: 'ARGUS_FORGET_PROC_ALIVE' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/токен продолжает действовать/)
  })

  it('оставшаяся задача автозапуска на Windows — тоже провал', () => {
    const r = decideForgetOutcome({ family: 'windows', execOk: true, output: 'ARGUS_FORGET_TASK_ALIVE' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/прав/)
  })
})
