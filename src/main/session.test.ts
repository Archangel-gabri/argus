// Разбор состояния сеансов на РЕАЛЬНОМ выводе loginctl.
//
// Образцы сняты с живой машины (ПК castiel-pc, Arch + KDE Plasma 6 Wayland, автовход, linger)
// и дополнены ловушками, каждая из которых уже кого-то подводила:
//   • первым в списке идёт Class=manager — это `systemd --user` от linger, а не рабочий стол;
//   • номер сеанса меняется после перезагрузки, поэтому выбирать по нему нельзя;
//   • наш собственный ssh-сеанс тоже в списке: Remote=yes и пустой Seat;
//   • залипший старый сеанс остаётся в состоянии online и живой картинки не даёт.
import { execFileSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { parseSessions, pickGraphical, unlockCmd, LIST_SESSIONS_CMD, WINDOWS_LOCK_CMD } from './session'

// Ровно то, что печатает LIST_SESSIONS_CMD на стенде.
const LIVE = `SESSION=1
Type=unspecified
Class=manager
Active=yes
State=active
LockedHint=no
Remote=no
Seat=
Desktop=
SESSION=15
Type=tty
Class=user
Active=no
State=online
LockedHint=no
Remote=yes
Seat=
Desktop=
SESSION=2
Type=wayland
Class=user
Active=yes
State=active
LockedHint=yes
Remote=no
Seat=seat0
Desktop=KDE`

describe('parseSessions', () => {
  const list = parseSessions(LIVE)

  it('находит все три сеанса', () => {
    expect(list.map((s) => s.id)).toEqual(['1', '15', '2'])
  })

  it('разбирает поля графического сеанса', () => {
    const gui = list.find((s) => s.id === '2')
    expect(gui).toMatchObject({
      type: 'wayland',
      klass: 'user',
      active: true,
      state: 'active',
      locked: true,
      remote: false,
      seat: 'seat0',
      desktop: 'KDE'
    })
  })

  it('пустой Seat остаётся пустым, а не превращается в значение', () => {
    expect(list.find((s) => s.id === '15')?.seat).toBe('')
  })

  it('нет loginctl — пустой список, а не мусор', () => {
    expect(parseSessions('NO_LOGINCTL')).toHaveLength(0)
  })

  it('пустой ввод — пустой список', () => {
    expect(parseSessions('')).toHaveLength(0)
  })

  it('свойства без объявленного сеанса игнорируются', () => {
    // Так выглядит вывод `loginctl show-session` БЕЗ аргумента: он печатает свойства
    // менеджера. Принять их за сеанс — значит выдать правдоподобный мусор.
    expect(parseSessions('Type=wayland\nClass=user\nActive=yes')).toHaveLength(0)
  })

  it('незнакомые поля не роняют разбор', () => {
    const r = parseSessions('SESSION=7\nType=x11\nCanLock=yes\nIdleHint=no\nClass=user')
    expect(r).toHaveLength(1)
    expect(r[0].type).toBe('x11')
  })
})

describe('pickGraphical', () => {
  it('выбирает графический сеанс, а не первый в списке', () => {
    const pick = pickGraphical(parseSessions(LIVE))
    expect(pick?.id).toBe('2')
  })

  it('не принимает Class=manager за рабочий стол', () => {
    const only = parseSessions(`SESSION=1
Type=unspecified
Class=manager
Active=yes
State=active
Seat=`)
    expect(pickGraphical(only)).toBeNull()
  })

  it('не принимает экран приветствия', () => {
    const greeter = parseSessions(`SESSION=c1
Type=wayland
Class=greeter
Active=yes
State=active
Seat=seat0`)
    expect(pickGraphical(greeter)).toBeNull()
  })

  it('не принимает ssh-сеанс, даже если он user', () => {
    const ssh = parseSessions(`SESSION=44
Type=tty
Class=user
Active=no
State=online
Remote=yes
Seat=`)
    expect(pickGraphical(ssh)).toBeNull()
  })

  it('из двух графических берёт активный, а не залипший', () => {
    const two = parseSessions(`SESSION=3
Type=wayland
Class=user
Active=no
State=online
Seat=seat0
SESSION=9
Type=wayland
Class=user
Active=yes
State=active
Seat=seat0`)
    expect(pickGraphical(two)?.id).toBe('9')
  })

  it('никто не вошёл — null, и это отличается от ошибки', () => {
    expect(pickGraphical([])).toBeNull()
  })
})

describe('команды для удалённой оболочки', () => {
  // Самая полезная проверка в этом файле. Команды склеиваются из строк, и одна пропущенная
  // точка с запятой делает всю команду нерабочей — «syntax error near unexpected token `for'».
  // Ровно это и случилось: после `{ …; }` при склейке через пробел не оказывалось разделителя,
  // и удалённая оболочка не выполняла НИЧЕГО. Проверка подстрок такое пропускает, поэтому
  // синтаксис проверяет сама оболочка (`bash -n` разбирает, но не выполняет).
  const syntaxOk = (cmd: string): boolean => {
    try {
      execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  it('перечисление сеансов — синтаксически корректная команда оболочки', () => {
    expect(syntaxOk(LIST_SESSIONS_CMD)).toBe(true)
  })

  it('снятие замка — синтаксически корректная команда оболочки', () => {
    expect(syntaxOk(unlockCmd('2'))).toBe(true)
  })

  it('перечисление сеансов не полагается на порядок полей', () => {
    // Свойства запрашиваются с именами (без --value): разбор по позиции однажды дал бы
    // чужое значение, потому что состав вывода зависит от версии systemd.
    expect(LIST_SESSIONS_CMD).not.toContain('--value')
    expect(LIST_SESSIONS_CMD).toContain('-p LockedHint')
  })

  it('снятие замка — только для одного сеанса, никогда для всех', () => {
    const cmd = unlockCmd('2')
    expect(cmd).toContain("unlock-session '2'")
    // `unlock-sessions` (все сразу) не имеет владельца, поэтому polkit требует
    // интерактивной авторизации и по SSH такая команда падает.
    expect(cmd).not.toContain('unlock-sessions')
  })

  it('результат проверяется по факту, а не по коду возврата', () => {
    // logind только рассылает сигнал — снимает замок рабочая среда, и она может его
    // проигнорировать (например, Sway по умолчанию). Поэтому опрашиваем LockedHint.
    expect(unlockCmd('2')).toContain('LockedHint --value')
    expect(unlockCmd('2')).toContain('LOCKED=')
  })

  it('номер сеанса экранируется', () => {
    expect(unlockCmd("2'; rm -rf /")).not.toMatch(/rm -rf \/(?!')/)
  })

  it('монитор будится на X11, но не крашащимся инструментом на Wayland', () => {
    const cmd = unlockCmd('2')
    // На X11 xset дешёв и безопасен.
    expect(cmd).toContain('xset dpms force on')
    // kscreen-doctor (задокументированный способ KDE на Wayland) на живой машине падает
    // с core dump — ронять чужой инструмент ради необязательного улучшения нельзя.
    expect(cmd).not.toContain('kscreen-doctor')
  })
})

describe('состояние экрана Windows', () => {
  // На Windows экран блокировки живёт на защищённом рабочем столе: агент видит только
  // рабочий стол пользователя, поэтому при блокировке он показал бы застывшую картинку.
  // Признак блокировки — работающий LogonUI.exe, он же её и рисует.
  it('команда ищет LogonUI и отвечает однозначно', () => {
    expect(WINDOWS_LOCK_CMD).toContain('LogonUI.exe')
    expect(WINDOWS_LOCK_CMD).toContain('LOCKED=yes')
    expect(WINDOWS_LOCK_CMD).toContain('LOCKED=no')
  })

  it('команда не падает, когда процесса нет', () => {
    // tasklist с фильтром без совпадений печатает информационную строку и возвращает 0,
    // поэтому решение принимает find, а не код возврата tasklist.
    expect(WINDOWS_LOCK_CMD).toContain('find')
    expect(WINDOWS_LOCK_CMD).toContain('2>nul')
  })
})
