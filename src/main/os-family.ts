/**
 * Настоящее семейство ОС удалённой машины — по ответу самой машины.
 *
 * `whichOs` из `pc.ts` различает всего две семьи: всё, что не Windows, считается Linux.
 * Для метрик и питания этого хватает, а для всего, что ставит файлы и службы, — нет:
 * на macOS автозапуском заведует launchd, и linux-ветка его не тронет. Поэтому семейство
 * спрашивается у машины (`uname -s`), а здесь лежит разбор ответа — чтобы он был один и тот же
 * и при установке агента, и при его отзыве, и проверялся без живой машины.
 */
export type RemoteFamily = 'windows' | 'darwin' | 'freebsd' | 'linux'

export function remoteFamily(isWindows: boolean, unameOutput: string): RemoteFamily {
  if (isWindows) return 'windows'
  const raw = (unameOutput || '').trim().toLowerCase()
  if (/darwin/.test(raw)) return 'darwin'
  if (/bsd/.test(raw)) return 'freebsd'
  // Пустой ответ трактуем как Linux сознательно: это самый частый случай и самая безобидная
  // ошибка — linux-ветка на непонятной машине просто не найдёт, что удалять.
  return 'linux'
}

export function remoteArch(unameOutput: string): 'arm64' | 'amd64' {
  return /arm64|aarch64/.test((unameOutput || '').toLowerCase()) ? 'arm64' : 'amd64'
}
