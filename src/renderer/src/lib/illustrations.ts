// Изо-портреты сущностей (REDESIGN-2026-07 §2.3). kind → портрет; серверы — по роли.
import master from '@/assets/illustrations/server-master.png'
import cascade from '@/assets/illustrations/server-cascade.png'
import exitNode from '@/assets/illustrations/server-exit.png'
import generic from '@/assets/illustrations/server-generic.png'
import pc from '@/assets/illustrations/device-pc.png'
import phone from '@/assets/illustrations/device-phone.png'
import watch from '@/assets/illustrations/device-watch.png'
import buds from '@/assets/illustrations/device-buds.png'
import router from '@/assets/illustrations/device-router.png'
import type { DeviceKind } from '@/types'

const BY_ROLE: Array<[RegExp, string]> = [
  [/master/i, master],
  [/cascade|relay/i, cascade],
  [/exit/i, exitNode]
]

// Автоподбор портрета по типу. Картинки телефона/часов/наушников остались в каталоге —
// их по-прежнему можно выбрать руками для устройства типа «другое», просто типов таких больше нет.
const BY_KIND: Partial<Record<DeviceKind, string>> = {
  pc,
  router
}

/** Каталог встроенных портретов — из него строится выбор в форме устройства. */
export const ILLUSTRATIONS: Array<{ key: string; label: string; src: string }> = [
  { key: 'server-generic', label: 'Сервер', src: generic },
  { key: 'server-master', label: 'Сервер · главный', src: master },
  { key: 'server-cascade', label: 'Сервер · каскад', src: cascade },
  { key: 'server-exit', label: 'Сервер · выходной узел', src: exitNode },
  { key: 'device-pc', label: 'Компьютер', src: pc },
  { key: 'device-router', label: 'Роутер', src: router },
  { key: 'device-phone', label: 'Телефон', src: phone },
  { key: 'device-watch', label: 'Часы', src: watch },
  { key: 'device-buds', label: 'Наушники', src: buds }
]

const BY_KEY = new Map(ILLUSTRATIONS.map((i) => [i.key, i.src]))

/**
 * Портрет устройства. Приоритет: ВЫБОР ПОЛЬЗОВАТЕЛЯ → эвристика по типу и роли.
 *
 * icon хранит либо ключ встроенного портрета, либо data-URL своей картинки. Раньше выбора не
 * было вовсе: картинка определялась типом и регуляркой по роли, и поменять её было нельзя.
 */
export function deviceIllustration(kind: DeviceKind, role: string | null, icon?: string | null): string {
  if (icon) {
    if (icon.startsWith('data:')) return icon
    const built = BY_KEY.get(icon)
    if (built) return built
  }
  if (kind !== 'server') return BY_KIND[kind] ?? generic
  if (role) {
    for (const [re, img] of BY_ROLE) if (re.test(role)) return img
  }
  return generic
}

/** Что показывается по умолчанию — нужно, чтобы подсветить текущий выбор в форме. */
export function defaultIllustrationKey(kind: DeviceKind, role: string | null): string {
  if (kind !== 'server') return kind === 'pc' ? 'device-pc' : `device-${kind}`
  if (role) {
    if (/master/i.test(role)) return 'server-master'
    if (/cascade|relay/i.test(role)) return 'server-cascade'
    if (/exit/i.test(role)) return 'server-exit'
  }
  return 'server-generic'
}
