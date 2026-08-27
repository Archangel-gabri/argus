import type { PowerAction } from '../types'

/**
 * Разбор действия питания, пришедшего по IPC.
 *
 * Отдельный модуль, а не выражение внутри обработчика, по одной причине: раньше строка
 * читалась так —
 *
 *     a === 'poweroff' || a === 'suspend' ? a : 'reboot'
 *
 * — то есть ЛЮБОЕ неузнанное значение (пустая строка, `null`, опечатка, переименованная
 * кнопка) молча превращалось в перезагрузку живой машины. Действие необратимое, а ветка
 * «иначе» вела именно к нему: замок, открывающийся сам, если ключ не подошёл.
 *
 * Неизвестное действие — это ошибка вызывающего, а не повод что-то сделать с чужим сервером.
 */
const KNOWN = ['reboot', 'poweroff', 'suspend'] as const

export function resolvePowerAction(raw: unknown): PowerAction | null {
  if (typeof raw !== 'string') return null
  // Без trim и без приведения регистра: значения приходят от нашего же интерфейса,
  // и «почти правильное» слово должно быть отвергнуто, а не угадано.
  return (KNOWN as readonly string[]).includes(raw) ? (raw as PowerAction) : null
}

/** Короткое описание для сообщения об ошибке — без интерполяции чужой строки в текст команды. */
export function describeRejectedAction(raw: unknown): string {
  if (typeof raw !== 'string') return typeof raw
  return raw === '' ? 'пустая строка' : JSON.stringify(raw.slice(0, 40))
}
