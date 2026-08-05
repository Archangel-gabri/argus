// Состояние графического сеанса на удалённой машине: вошёл ли кто-то и заперт ли экран.
//
// Зачем это вообще нужно. Владелец жаловался, что экран Linux-машины «не показывается, пока не
// войдёшь в систему». На живом стенде выяснилось, что войти-то он вошёл — сеанс поднимается сам
// (автовход), — а экран был ЗАПЕРТ хранителем экрана. И это снимается удалённо одной командой
// без всякого пароля: `loginctl unlock-session`. То есть препятствие, из-за которого удалённый
// экран считался неработающим, стоило одного вызова.
//
// Почему замок снимается МОЛЧА, без вопроса: подключение к экрану своей машины из своего же
// приложения — это и есть решение хозяина. Спрашивать второй раз то, что уже подтверждено
// самим нажатием, — лишний шаг. При этом на самой машине агент показывает уведомление о
// подключении, так что происходящее не скрыто от того, кто сидит за ней.

import { execOnce } from './ssh'
import { whichOs, osReachable, unreachableReason } from './pc'

/** Один сеанс logind в том виде, в каком его описывает `loginctl show-session`. */
export type RemoteSession = {
  id: string
  /** UID владельца SSH-подключения и UID самого сеанса. Оба нужны: root не должен снять чужой замок. */
  ownerUid: string
  userUid: string
  type: string // wayland | x11 | tty | unspecified
  klass: string // user | greeter | manager
  active: boolean | null
  state: string // active | online | closing
  /** null означает «logind не отдал факт»; неизвестность нельзя принимать за открытый экран. */
  locked: boolean | null
  remote: boolean | null
  seat: string
  desktop: string
}

export type ScreenAccess =
  /** Замок был и мы его сняли. */
  | { state: 'unlocked'; sessionId: string }
  /** Экран и так открыт. */
  | { state: 'already'; sessionId: string }
  /** Графического сеанса нет вообще — показывать нечего, и это надо сказать прямо. */
  | { state: 'no-session' }
  /** Команда прошла, но замок остался: рабочая среда не слушает logind. */
  | { state: 'refused'; sessionId: string; detail?: string }
  /**
   * Экран заперт, и снять замок нечем. Это НЕ то же самое, что «не поддерживается»: смотреть
   * можно, но не агентом — на Windows экран блокировки живёт на защищённом рабочем столе, и
   * обычный процесс его не видит. Значит нужен запасной путь.
   */
  | { state: 'locked-no-unlock'; reason: string }
  /** Этой системе такой способ не подходит (нет loginctl, машина не в сети). */
  | { state: 'unsupported'; reason: string }

/**
 * Одна команда, которая перечисляет ВСЕ сеансы со всеми нужными полями.
 *
 * Свойства запрашиваются без `--value`: имена полей нужны, потому что порядок и состав вывода
 * зависят от версии systemd, а разбирать по позиции — способ однажды получить чужое значение.
 * Каждый блок начинается строкой SESSION=<id>, иначе непонятно, к кому относятся свойства.
 */
// Склеиваем ПЕРЕВОДАМИ СТРОК, а не пробелами. Через пробел получалось
// `…{ echo NO_LOGINCTL; exit 0; } for s in …` — после закрывающей фигурной скобки нет
// разделителя, и удалённая оболочка отказывалась выполнять команду целиком («syntax error
// near unexpected token `for'»). Поймано живым прогоном; юнит-тест на подстроки этого не видел,
// поэтому ниже добавлена проверка синтаксиса самой оболочкой.
export const LIST_SESSIONS_CMD = [
  'command -v loginctl >/dev/null 2>&1 || { echo NO_LOGINCTL; exit 0; }',
  'echo "OWNER_UID=$(id -u)"',
  "for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do",
  '  echo "SESSION=$s"',
  '  loginctl show-session "$s" -p User -p Type -p Class -p Active -p State -p LockedHint -p Remote -p Seat -p Desktop 2>/dev/null',
  'done'
].join('\n')

/**
 * Снять замок и ПРОВЕРИТЬ результат: команда возвращает 0 и когда среда её проигнорировала.
 *
 * Только `unlock-session <ID>` и никогда `unlock-sessions` (все сразу): первая форма проходит
 * без пароля, потому что logind сверяет UID вызывающего с владельцем сеанса и при совпадении
 * не обращается к polkit вовсе; у формы «все сеансы» владельца нет, и по SSH она упадёт с
 * «Interactive authentication required».
 *
 * Про погашенный монитор (DPMS). На X11 будим через `xset` — это дешёвая и безопасная команда.
 * На Wayland задокументированный способ у KDE — `kscreen-doctor --dpms on`, и его тут НЕТ
 * сознательно: на живой машине (Plasma 6, Wayland) он падает с core dump. Ронять чужой
 * инструмент ради необязательного улучшения нельзя. Пробуждение на Wayland остаётся за
 * уведомлением агента и первым же движением мыши от пользователя — оба будят экран сами.
 */
export function unlockCmd(sessionId: string): string {
  const id = shellSingleQuote(sessionId)
  return [
    `loginctl unlock-session ${id} >/dev/null 2>&1 || echo UNLOCK_CALL_FAILED`,
    '[ -n "$DISPLAY" ] && command -v xset >/dev/null 2>&1 && xset dpms force on >/dev/null 2>&1',
    // Снятие замка асинхронно: команда лишь посылает сигнал, а убирает окно хранитель экрана.
    // Поэтому опрашиваем, а не верим на слово. Три секунды с шагом 0.3с — на живой машине
    // замок уходил за первые 0.3с.
    'for i in 1 2 3 4 5 6 7 8 9 10; do',
    `  L=$(loginctl show-session ${id} -p LockedHint --value 2>/dev/null)`,
    '  [ "$L" = "no" ] && break',
    '  sleep 0.3',
    'done',
    'echo "LOCKED=$L"'
  ].join('\n')
}

/**
 * Экран Windows: заперт ли. Признак — работающий LogonUI.exe, он же рисует экран блокировки.
 *
 * Через `-EncodedCommand`, а не строкой cmd.exe. Причина та же, что у остальных Windows-команд
 * в этом проекте и уже однажды оплаченная отладкой: DefaultShell у OpenSSH на машине владельца
 * — PowerShell, а этот синтаксис (`2>nul`, `&&`, `||`, `find /I`) он не разбирает. Под самим
 * cmd.exe конструкция тоже вырождается: `find` возвращает ненулевой код, и ветка `||` печатает
 * «LOCKED=no» независимо от того, заперт экран или нет. То есть проба отвечала «не заперт»
 * всегда — на обоих шеллах, но по разным причинам.
 */
const WINDOWS_LOCK_PS =
  "$p = Get-Process -Name LogonUI -ErrorAction SilentlyContinue; " +
  "Write-Output ('LOCKED=' + $(if ($p) { 'yes' } else { 'no' }))"
export const WINDOWS_LOCK_CMD = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
  WINDOWS_LOCK_PS,
  'utf16le'
).toString('base64')}`

function shellSingleQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

/** Разбор вывода LIST_SESSIONS_CMD. Неизвестные поля игнорируются, а не роняют разбор. */
export function parseSessions(out: string): RemoteSession[] {
  if (/^\s*NO_LOGINCTL\s*$/m.test(out)) return []
  const list: RemoteSession[] = []
  let cur: RemoteSession | null = null
  let ownerUid = ''
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const owner = /^OWNER_UID=(\d+)$/.exec(line)
    if (owner) {
      ownerUid = owner[1]
      continue
    }
    const sess = /^SESSION=(.+)$/.exec(line)
    if (sess) {
      cur = {
        id: sess[1].trim(),
        ownerUid,
        userUid: '',
        type: '',
        klass: '',
        active: null,
        state: '',
        locked: null,
        remote: null,
        seat: '',
        desktop: ''
      }
      list.push(cur)
      continue
    }
    if (!cur) continue
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    switch (key) {
      case 'User':
        cur.userUid = value.trim()
        break
      case 'Type':
        cur.type = value.trim().toLowerCase()
        break
      case 'Class':
        cur.klass = value.trim().toLowerCase()
        break
      case 'Active':
        cur.active = value.trim() === 'yes' ? true : value.trim() === 'no' ? false : null
        break
      case 'State':
        cur.state = value.trim().toLowerCase()
        break
      case 'LockedHint':
        cur.locked = value.trim() === 'yes' ? true : value.trim() === 'no' ? false : null
        break
      case 'Remote':
        cur.remote = value.trim() === 'yes' ? true : value.trim() === 'no' ? false : null
        break
      case 'Seat':
        cur.seat = value.trim()
        break
      case 'Desktop':
        cur.desktop = value.trim()
        break
    }
  }
  return list.filter((s) => s.id !== '')
}

export type GraphicalSelection =
  | { kind: 'selected'; session: RemoteSession }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'unknown'; detail: string }

const displayClasses = new Set(['user', 'user-early', 'user-light', 'user-early-light'])

/**
 * Выбор физического рабочего стола — fail closed: каждое критичное поле должно быть известно,
 * сеанс должен принадлежать SSH-пользователю и быть единственным активным кандидатом.
 */
export function selectGraphical(list: RemoteSession[]): GraphicalSelection {
  const plausible = list.filter(
    (s) =>
      displayClasses.has(s.klass) &&
      (s.type === 'wayland' || s.type === 'x11' || s.type === 'mir') &&
      s.seat !== ''
  )
  if (plausible.length === 0) return { kind: 'none' }

  const ownedLocal = plausible.filter(
    (s) => s.ownerUid !== '' && s.userUid !== '' && s.ownerUid === s.userUid && s.remote === false
  )
  if (ownedLocal.length === 0) {
    return { kind: 'unknown', detail: 'графический сеанс не принадлежит SSH-пользователю или его UID неизвестен' }
  }

  const active = ownedLocal.filter((s) => s.active === true && s.state === 'active')
  if (active.length === 0) {
    return { kind: 'unknown', detail: 'графический сеанс есть, но ни один не подтверждён как активный' }
  }
  if (active.length > 1) return { kind: 'ambiguous', count: active.length }
  if (active[0].locked === null) {
    return { kind: 'unknown', detail: 'logind не сообщил состояние блокировки экрана' }
  }
  return { kind: 'selected', session: active[0] }
}

/**
 * Выбрать сеанс, экран которого мы и увидим при трансляции.
 *
 * По НОМЕРУ выбирать нельзя: он меняется при каждой перезагрузке (на стенде был 2, после
 * перезагрузки — другой), и зашитая «сессия 2» однажды показала бы чужой или мёртвый сеанс.
 *
 * Признаки настоящего локального графического сеанса: класс user, тип wayland/x11/mir, есть
 * место (seat) и он не удалённый. Каждое условие отсекает конкретную ловушку:
 *   • `Class=manager` — это `systemd --user`, он появляется от linger и на живой машине идёт
 *     в списке ПЕРВЫМ; взяв первый попавшийся, мы бы целились в него;
 *   • `Class=greeter` — экран приветствия, у него свой сеанс, и транслировать его нечем;
 *   • пустой seat и Remote=yes — это ssh-сеансы, включая наш собственный.
 * Из подходящих берём активный, а среди активных — тот, что в состоянии active: залипшие
 * старые сеансы остаются в online/closing и живой картинки не дадут.
 */
export function pickGraphical(list: RemoteSession[]): RemoteSession | null {
  const selected = selectGraphical(list)
  return selected.kind === 'selected' ? selected.session : null
}

type ExecResult = { ok: boolean; output: string; error?: string }

/** Успех разблокировки доказывает только точное `LOCKED=no`; пустой/иной ответ — неизвестность. */
export function interpretUnlockResult(r: ExecResult): { ok: true } | { ok: false; detail: string } {
  if (!r.ok) return { ok: false, detail: r.error || 'команда разблокировки завершилась ошибкой' }
  if (/^UNLOCK_CALL_FAILED$/m.test(r.output)) {
    return { ok: false, detail: 'logind отказался послать сигнал разблокировки' }
  }
  const state = /^LOCKED=(yes|no)$/m.exec(r.output)?.[1]
  if (state === 'no') return { ok: true }
  if (state === 'yes') return { ok: false, detail: 'рабочая среда не сняла замок по сигналу logind' }
  return { ok: false, detail: 'logind не подтвердил состояние экрана после разблокировки' }
}

/** Windows fail closed: любой сбой/неизвестный ответ отправляет в безопасный RDP fallback. */
export function interpretWindowsLockProbe(r: ExecResult): ScreenAccess {
  if (r.ok && /^LOCKED=no$/im.test(r.output)) return { state: 'already', sessionId: 'windows-console' }
  if (r.ok && /^LOCKED=yes$/im.test(r.output)) {
    return {
      state: 'locked-no-unlock',
      reason: 'экран Windows заперт: агент видит только рабочий стол пользователя, а экран блокировки живёт на защищённом'
    }
  }
  return {
    state: 'locked-no-unlock',
    reason: `не удалось надёжно проверить блокировку Windows (${r.error || 'ответ не распознан'}) — агент не открываю`
  }
}

/**
 * Привести экран машины в состояние, в котором его есть смысл транслировать.
 *
 * Возвращает не «получилось/не получилось», а РАЗЛИЧИМЫЕ состояния: «сняли замок», «был
 * открыт», «никто не вошёл», «среда не слушает». Разница важна, потому что показывать
 * пользователю нужно разное, а чёрный экран не объясняет ничего.
 */
export async function ensureScreenUnlocked(deviceId: string): Promise<ScreenAccess> {
  const os = await whichOs(deviceId)
  // «Не знаю» — не повод угадывать: ветка ниже разделена по семейству, и неизвестность
  // проваливалась в Linux-путь, отправляя `loginctl` на Windows-машину. Ответ честный:
  // спросить не удалось, состоянием экрана управлять нечем.
  if (!osReachable(os.family)) return { state: 'unsupported', reason: unreachableReason(os.family) }
  if (os.family === 'windows') {
    // Windows не даёт снять блокировку без пароля: экран блокировки живёт на защищённом
    // рабочем столе, и обычному процессу он недоступен — ни показать, ни разблокировать.
    const r = await execOnce(deviceId, WINDOWS_LOCK_CMD)
    return interpretWindowsLockProbe(r)
  }

  const listed = await execOnce(deviceId, LIST_SESSIONS_CMD)
  if (!listed.ok) return { state: 'unsupported', reason: listed.error || 'не удалось опросить сеансы' }
  if (/NO_LOGINCTL/.test(listed.output))
    return { state: 'unsupported', reason: 'в системе нет loginctl — состоянием экрана управлять нечем' }

  const selected = selectGraphical(parseSessions(listed.output))
  if (selected.kind === 'none') return { state: 'no-session' }
  if (selected.kind === 'ambiguous') {
    return { state: 'unsupported', reason: `найдено несколько активных графических сеансов (${selected.count}) — не угадываю нужный` }
  }
  if (selected.kind === 'unknown') return { state: 'unsupported', reason: selected.detail }
  const target = selected.session
  if (!target.locked) return { state: 'already', sessionId: target.id }

  // Снятие замка вынесено во ВТОРОЙ вызов намеренно: выбор сеанса — это логика, которую надо
  // проверять тестами, а не прятать в строку для удалённой оболочки. Плата известна и принята:
  // пула соединений в проекте нет, каждый execOnce — это отдельное рукопожатие. Не считать её
  // бесплатной: остальной код зоны собирает по одной команде на задачу именно поэтому.
  const un = await execOnce(deviceId, unlockCmd(target.id))
  const verdict = interpretUnlockResult(un)
  if (!verdict.ok) {
    return {
      state: 'refused',
      sessionId: target.id,
      detail: verdict.detail
    }
  }
  return { state: 'unlocked', sessionId: target.id }
}
