/**
 * Вердикты о состоянии агента — по фактам, а не по намерению.
 *
 * Здесь собраны две проверки, которые раньше отвечали «да» слишком легко:
 *
 *  — установка службы на Windows считалась успешной по коду возврата, хотя скрипт шёл без
 *    остановки на ошибке и заканчивался словом 'ok';
 *  — агент считался рабочим по одному полю `ok` в ответе `/health`, а сообщённая им версия
 *    просто клалась в результат и ни с чем не сверялась. Несовместимый агент объявлялся
 *    готовым, окно трансляции открывалось, и разваливалось всё уже на разборе кадров — то есть
 *    далеко от причины.
 */

export interface WindowsServiceVerdict {
  ok: boolean
  error?: string
}

export function interpretWindowsService(output: string, execOk: boolean): WindowsServiceVerdict {
  const err = /ARGUS_SVC_ERR=(.*)/.exec(output)?.[1]?.trim()
  if (!/ARGUS_SVC_DONE/.test(output))
    return {
      ok: false,
      error: err
        ? `автозапуск не настроен: ${err}`
        : execOk
          ? 'машина не сообщила состояние автозапуска'
          : 'команда установки автозапуска не выполнилась'
    }

  const task = /ARGUS_SVC_TASK=(\d)/.exec(output)?.[1] === '1'
  const fw = /ARGUS_SVC_FW=(\d)/.exec(output)?.[1] === '1'

  if (!task)
    return {
      ok: false,
      error: err
        ? `задача автозапуска не создана: ${err}`
        : 'задача автозапуска не создана — вероятно, не хватило прав администратора'
    }
  if (!fw)
    return {
      ok: false,
      error: err
        ? `правило firewall для tailnet не создано: ${err}`
        : 'правило firewall для tailnet не создано — агент был бы виден и в локальной сети'
    }
  return { ok: true }
}

export interface HealthVerdict {
  installed: boolean
  running: boolean
  version?: string
  /** Версия агента не совпадает с ожидаемой — говорить об этом надо ДО открытия окна. */
  outdated: boolean
  error?: string
}

/** Совместимость по мажорной и минорной части: заплатки протокол не меняют. */
export function versionCompatible(reported: string | undefined, expected: string): boolean {
  if (!reported) return false
  const part = (v: string): string => v.trim().split('.').slice(0, 2).join('.')
  return part(reported) === part(expected)
}

export function interpretHealth(
  body: { ok?: boolean; version?: string; os?: string; error?: string },
  expectedVersion: string
): HealthVerdict {
  const alive = !!body.ok
  if (!alive)
    return { installed: true, running: false, version: body.version, outdated: false, error: body.error }

  const compatible = versionCompatible(body.version, expectedVersion)
  return {
    installed: true,
    running: compatible,
    version: body.version,
    outdated: !compatible,
    error: compatible
      ? body.error
      : `на машине агент версии ${body.version ?? 'неизвестной'}, ожидается ${expectedVersion} — переустанови его`
  }
}
