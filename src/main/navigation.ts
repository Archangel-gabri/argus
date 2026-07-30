/** Разрешён ли URL для открытия системным браузером. Локальные файлы, javascript: и
 * произвольные custom schemes из renderer запускать нельзя. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
