/**
 * Отзыв агента трансляции — команда и вердикт.
 *
 * Прежняя реализация делала три вещи неверно, и все три тихо:
 *
 *  1. Сначала стирала токен У СЕБЯ, и только потом шла на машину. Обрыв посередине давал
 *     худшее из возможных: Argus про токен забыл, а агент на машине с ним же продолжает
 *     работать — отозвать больше нечего, потому что нечем.
 *  2. Удаляла файлы, но НЕ останавливала службу. Агент читает токен один раз при старте и
 *     держит в памяти: пока процесс жив, удаление файла ничего не отзывает.
 *  3. При недоступной машине возвращала `ok: true` — «забыли», хотя не отозвано ничего.
 *
 * Отсюда порядок: сначала остановить процесс, потом убрать файлы, и только после
 * подтверждённого успеха забывать токен у себя.
 */
// Строка, а не перечисление: семейство приходит от удалённой машины, и незнакомое значение
// надо донести до вызывающего как есть, а не подменить ближайшим известным. Названия ниже —
// подсказка читателю, какие значения встречаются на практике.
/** 'linux' | 'windows' | 'darwin' | 'off' — либо любое другое, что ответила машина. */
export type OsFamily = string

export type ForgetOutcome =
  /** Служба остановлена, файлы убраны, локальный токен можно стирать. */
  | { revoked: 'remote'; ok: true }
  /** Машина недоступна: на ней всё ещё живёт агент с действующим токеном. */
  | { revoked: 'pending'; ok: false; error: string }
  /** Дошли до машины, но снять не удалось. Токен НЕ стираем — иначе отзывать будет нечем. */
  | { revoked: 'failed'; ok: false; error: string }

/** Команда, которая сначала гасит автозапуск и процесс, и только затем удаляет ключевой материал. */
export function buildForgetCommand(family: OsFamily, darwinJob?: string): string {
  if (family === 'windows') {
    return (
      `Stop-ScheduledTask -TaskName 'ArgusAgent' -EA SilentlyContinue; ` +
      `Unregister-ScheduledTask -TaskName 'ArgusAgent' -Confirm:$false -EA SilentlyContinue; ` +
      `Get-Process argus-agent -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue; ` +
      `Remove-Item "$env:LOCALAPPDATA\\Argus\\agent.crt","$env:LOCALAPPDATA\\Argus\\agent.key",` +
      `"$env:LOCALAPPDATA\\Argus\\agent.token" -Force -EA SilentlyContinue; ` +
      // Доказываем результат, а не печатаем «ok»: задача должна исчезнуть, процесс — умереть.
      `if (Get-ScheduledTask -TaskName 'ArgusAgent' -EA SilentlyContinue) { 'ARGUS_FORGET_TASK_ALIVE' } ` +
      `elseif (Get-Process argus-agent -EA SilentlyContinue) { 'ARGUS_FORGET_PROC_ALIVE' } ` +
      `else { 'ARGUS_FORGET_OK' }`
    )
  }

  if (family === 'darwin' && darwinJob) {
    return [
      `launchctl bootout ${quote(darwinJob)} >/dev/null 2>&1 || true`,
      'pkill -f "$HOME/.argus/argus-agent" >/dev/null 2>&1 || true',
      'rm -f "$HOME/.argus/agent.crt" "$HOME/.argus/agent.key" "$HOME/.argus/agent.token"',
      // Живой процесс после этого означает, что отзыв не состоялся.
      'if pgrep -f "$HOME/.argus/argus-agent" >/dev/null 2>&1; then echo ARGUS_FORGET_PROC_ALIVE; else echo ARGUS_FORGET_OK; fi'
    ].join('; ')
  }

  return [
    'systemctl --user stop argus-agent.service >/dev/null 2>&1 || true',
    'systemctl --user disable argus-agent.service >/dev/null 2>&1 || true',
    'rm -f "$HOME/.config/systemd/user/argus-agent.service"',
    'systemctl --user daemon-reload >/dev/null 2>&1 || true',
    'pkill -f "$HOME/.argus/argus-agent" >/dev/null 2>&1 || true',
    'rm -f "$HOME/.argus/agent.crt" "$HOME/.argus/agent.key" "$HOME/.argus/agent.token"',
    'if pgrep -f "$HOME/.argus/argus-agent" >/dev/null 2>&1; then echo ARGUS_FORGET_PROC_ALIVE; else echo ARGUS_FORGET_OK; fi'
  ].join('; ')
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Вердикт по факту, а не по коду возврата: нулевой exit тут ничего не доказывает —
 * почти все шаги намеренно best-effort и заканчиваются `|| true`.
 */
export function decideForgetOutcome(input: {
  family: OsFamily
  execOk: boolean
  output: string
  error?: string
}): ForgetOutcome {
  if (input.family === 'off')
    return {
      revoked: 'pending',
      ok: false,
      error:
        'машина не в сети — агент на ней продолжает работать с прежним токеном. Отзыв состоится, когда она ответит.'
    }

  if (/ARGUS_FORGET_OK/.test(input.output)) return { revoked: 'remote', ok: true }

  if (/ARGUS_FORGET_TASK_ALIVE/.test(input.output))
    return { revoked: 'failed', ok: false, error: 'задача автозапуска осталась — вероятно, не хватило прав' }

  if (/ARGUS_FORGET_PROC_ALIVE/.test(input.output))
    return { revoked: 'failed', ok: false, error: 'процесс агента ещё жив — токен продолжает действовать' }

  return {
    revoked: 'failed',
    ok: false,
    error: input.error || 'не удалось подтвердить отзыв: машина не сообщила результат'
  }
}
