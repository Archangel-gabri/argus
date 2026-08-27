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
import {
  interpretUnlockResult,
  interpretWindowsLockProbe,
  parseSessions,
  pickGraphical,
  selectGraphical,
  unlockCmd,
  LIST_SESSIONS_CMD,
  WINDOWS_LOCK_CMD
} from './session'

// Ровно то, что печатает LIST_SESSIONS_CMD на стенде.
const LIVE = `OWNER_UID=1000
SESSION=1
User=1000
Type=unspecified
Class=manager
Active=yes
State=active
LockedHint=no
Remote=no
Seat=
Desktop=
SESSION=15
User=1000
Type=tty
Class=user
Active=no
State=online
LockedHint=no
Remote=yes
Seat=
Desktop=
SESSION=2
User=1000
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
      userUid: '1000',
      ownerUid: '1000',
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

  it('отсутствующий LockedHint остаётся неизвестным, а не превращается в «экран открыт»', () => {
    const [r] = parseSessions(`OWNER_UID=1000
SESSION=7
User=1000
Type=x11
Class=user
Active=yes
State=active
Remote=no
Seat=seat0`)
    expect(r.locked).toBeNull()
    expect(selectGraphical([r])).toMatchObject({ kind: 'unknown' })
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
    const two = parseSessions(`OWNER_UID=1000
SESSION=3
User=1000
Type=wayland
Class=user
Active=no
State=online
LockedHint=no
Remote=no
Seat=seat0
SESSION=9
User=1000
Type=wayland
Class=user
Active=yes
State=active
LockedHint=no
Remote=no
Seat=seat0`)
    expect(pickGraphical(two)?.id).toBe('9')
  })

  it('никто не вошёл — null, и это отличается от ошибки', () => {
    expect(pickGraphical([])).toBeNull()
  })

  it('не выбирает активный графический сеанс другого UID', () => {
    const other = parseSessions(`OWNER_UID=1000
SESSION=8
User=1001
Type=wayland
Class=user
Active=yes
State=active
LockedHint=no
Remote=no
Seat=seat0`)
    expect(selectGraphical(other)).toMatchObject({ kind: 'unknown' })
    expect(pickGraphical(other)).toBeNull()
  })

  it('не угадывает между двумя равноценными активными сеансами владельца', () => {
    const tied = parseSessions(`OWNER_UID=1000
SESSION=8
User=1000
Type=wayland
Class=user
Active=yes
State=active
LockedHint=no
Remote=no
Seat=seat0
SESSION=9
User=1000
Type=x11
Class=user-light
Active=yes
State=active
LockedHint=no
Remote=no
Seat=seat1`)
    expect(selectGraphical(tied)).toMatchObject({ kind: 'ambiguous', count: 2 })
    expect(pickGraphical(tied)).toBeNull()
  })

  it('не принимает online-сеанс за экран, который сейчас находится на физической консоли', () => {
    const background = parseSessions(`OWNER_UID=1000
SESSION=8
User=1000
Type=wayland
Class=user
Active=no
State=online
LockedHint=no
Remote=no
Seat=seat0`)
    expect(selectGraphical(background)).toMatchObject({ kind: 'unknown' })
    expect(pickGraphical(background)).toBeNull()
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
    expect(LIST_SESSIONS_CMD).toContain('-p User')
    expect(LIST_SESSIONS_CMD).toContain('OWNER_UID=')
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

  it('не считает пустой LockedHint или упавший unlock успехом', () => {
    expect(interpretUnlockResult({ ok: true, output: 'UNLOCK_CALL_FAILED\nLOCKED=' })).toMatchObject({ ok: false })
    expect(interpretUnlockResult({ ok: true, output: 'LOCKED=yes' })).toMatchObject({ ok: false })
    expect(interpretUnlockResult({ ok: true, output: 'LOCKED=' })).toMatchObject({ ok: false })
    expect(interpretUnlockResult({ ok: true, output: 'LOCKED=no' })).toEqual({ ok: true })
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
  /** Что на самом деле выполнится на машине: расшифровываем -EncodedCommand. */
  const decodedLockScript = (): string => {
    const b64 = /-EncodedCommand\s+(\S+)/.exec(WINDOWS_LOCK_CMD)?.[1] ?? ''
    return Buffer.from(b64, 'base64').toString('utf16le')
  }

  it('идёт через -EncodedCommand, а не строкой cmd.exe', () => {
    // DefaultShell у OpenSSH на машине владельца — PowerShell, и синтаксис cmd.exe
    // (`2>nul`, `&&`, `||`, `find /I`) он не разбирает. Под самим cmd.exe прежняя команда тоже
    // вырождалась: `find` возвращает ненулевой код, ветка `||` печатала «LOCKED=no» независимо
    // от того, заперт экран или нет. То есть проба отвечала «не заперт» ВСЕГДА — на обоих
    // шеллах, но по разным причинам.
    expect(WINDOWS_LOCK_CMD).toContain('-EncodedCommand')
    expect(WINDOWS_LOCK_CMD).not.toContain('2>nul')
    expect(WINDOWS_LOCK_CMD).not.toContain('find /I')
  })

  it('расшифрованный сценарий ищет LogonUI и отвечает однозначно', () => {
    const ps = decodedLockScript()
    expect(ps).toContain('LogonUI')
    expect(ps).toContain('LOCKED=')
    // Обе ветки присутствуют: «нет ответа» и «ответ no» — разные вещи.
    expect(ps).toContain("'yes'")
    expect(ps).toContain("'no'")
  })

  it('отсутствие процесса не считается ошибкой сценария', () => {
    // Get-Process без совпадений бросает; SilentlyContinue превращает это в пустой $p,
    // а решение принимает проверка $p, а не код возврата.
    expect(decodedLockScript()).toContain('SilentlyContinue')
  })

  it('открывает агент только после однозначного LOCKED=no', () => {
    expect(interpretWindowsLockProbe({ ok: true, output: 'LOCKED=no' })).toMatchObject({ state: 'already' })
    expect(interpretWindowsLockProbe({ ok: true, output: 'LOCKED=yes' })).toMatchObject({ state: 'locked-no-unlock' })
    expect(interpretWindowsLockProbe({ ok: false, output: '', error: 'exit 1' })).toMatchObject({
      state: 'locked-no-unlock'
    })
    expect(interpretWindowsLockProbe({ ok: true, output: 'INFO: unknown' })).toMatchObject({
      state: 'locked-no-unlock'
    })
  })
})
