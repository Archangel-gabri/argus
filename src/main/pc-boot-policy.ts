export const BOOT_READY_MARKER = 'ARGUS_BOOTNEXT_SET'

/**
 * Разрыв SSH после reboot ожидаем, но сам по себе ничего не доказывает: ECONNRESET мог прийти
 * ещё на рукопожатии. Успех разрешён только после маркера, напечатанного ПОСЛЕ принятого
 * BootNext/grub-reboot и ДО команды перезагрузки.
 */
export function bootCommandWasAccepted(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === BOOT_READY_MARKER)
}

/** BootNext принят, а reboot либо завершил команду, либо ожидаемо оборвал SSH. */
export function bootCommandSucceeded(commandOk: boolean, output: string, commandError?: string): boolean {
  if (!bootCommandWasAccepted(output)) return false
  if (commandOk) return true
  return /ECONNRESET|EPIPE|closed|disconnect|connection lost|socket hang up/i.test(commandError ?? '')
}

export function bootEntryListResult<T>(
  commandOk: boolean,
  output: string,
  entries: T[],
  commandError?: string
): { ok: boolean; entries: T[]; error?: string } {
  if (!commandOk)
    return {
      ok: false,
      entries: [],
      error: commandError || output.trim() || 'команда загрузочных записей завершилась с ошибкой'
    }
  if (output.trim() && entries.length === 0)
    return { ok: false, entries: [], error: 'вывод команды не распознан; список не считаю пустым' }
  return { ok: true, entries }
}
