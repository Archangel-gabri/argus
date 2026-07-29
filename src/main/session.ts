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
import { whichOs } from './pc'

/** Один сеанс logind в том виде, в каком его описывает `loginctl show-session`. */
export type RemoteSession = {
  id: string
  type: string // wayland | x11 | tty | unspecified
  klass: string // user | greeter | manager
  active: boolean
  state: string // active | online | closing
  locked: boolean
  remote: boolean
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
  /** Этой системе такой способ не подходит (Windows, нет loginctl, машина не в сети). */
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
  "for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do",
  '  echo "SESSION=$s"',
  '  loginctl show-session "$s" -p Type -p Class -p Active -p State -p LockedHint -p Remote -p Seat -p Desktop 2>/dev/null',
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

/** Экран Windows: заперт ли. Признак — работающий LogonUI.exe, он же рисует экран блокировки. */
export const WINDOWS_LOCK_CMD =
  'tasklist /FI "IMAGENAME eq LogonUI.exe" /NH 2>nul | find /I "LogonUI.exe" >nul && echo LOCKED=yes || echo LOCKED=no'

function shellSingleQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

/** Разбор вывода LIST_SESSIONS_CMD. Неизвестные поля игнорируются, а не роняют разбор. */
export function parseSessions(out: string): RemoteSession[] {
  if (/^\s*NO_LOGINCTL\s*$/m.test(out)) return []
  const list: RemoteSession[] = []
  let cur: RemoteSession | null = null
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const sess = /^SESSION=(.+)$/.exec(line)
    if (sess) {
      cur = {
        id: sess[1].trim(),
        type: '',
        klass: '',
        active: false,
        state: '',
        locked: false,
        remote: false,
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
      case 'Type':
        cur.type = value.trim().toLowerCase()
        break
      case 'Class':
        cur.klass = value.trim().toLowerCase()
        break
      case 'Active':
        cur.active = value.trim() === 'yes'
        break
      case 'State':
        cur.state = value.trim().toLowerCase()
        break
      case 'LockedHint':
        cur.locked = value.trim() === 'yes'
        break
      case 'Remote':
        cur.remote = value.trim() === 'yes'
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
  const graphical = list.filter(
    (s) =>
      s.klass === 'user' &&
      (s.type === 'wayland' || s.type === 'x11' || s.type === 'mir') &&
      s.seat !== '' &&
      !s.remote
  )
  if (graphical.length === 0) return null
  const rank = (s: RemoteSession): number =>
    (s.active ? 0 : 2) + (s.state === 'active' ? 0 : 1)
  return [...graphical].sort((a, b) => rank(a) - rank(b))[0]
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
  if (os.family === 'windows') {
    // Windows не даёт снять блокировку без пароля: экран блокировки живёт на защищённом
    // рабочем столе, и обычному процессу он недоступен — ни показать, ни разблокировать.
    const r = await execOnce(deviceId, WINDOWS_LOCK_CMD)
    const locked = /LOCKED=yes/i.test(r.output)
    return {
      state: 'unsupported',
      reason: locked
        ? 'экран Windows заперт, а снять блокировку без пароля нельзя — нужен запасной путь (RDP)'
        : 'Windows: блокировкой управляет сама система'
    }
  }

  const listed = await execOnce(deviceId, LIST_SESSIONS_CMD)
  if (!listed.ok) return { state: 'unsupported', reason: listed.error || 'не удалось опросить сеансы' }
  if (/NO_LOGINCTL/.test(listed.output))
    return { state: 'unsupported', reason: 'в системе нет loginctl — состоянием экрана управлять нечем' }

  const target = pickGraphical(parseSessions(listed.output))
  if (!target) return { state: 'no-session' }
  if (!target.locked) return { state: 'already', sessionId: target.id }

  // Снятие замка вынесено во ВТОРОЙ вызов намеренно: выбор сеанса — это логика, которую надо
  // проверять тестами, а не прятать в строку для удалённой оболочки. Соединение SSH к этому
  // моменту уже установлено и переиспользуется, так что второй вызов стоит недорого.
  const un = await execOnce(deviceId, unlockCmd(target.id))
  const still = /LOCKED=yes/.test(un.output)
  if (!un.ok || still) {
    return {
      state: 'refused',
      sessionId: target.id,
      detail: un.error || (still ? 'рабочая среда не сняла замок по сигналу logind' : undefined)
    }
  }
  return { state: 'unlocked', sessionId: target.id }
}
