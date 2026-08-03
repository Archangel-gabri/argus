// UI-настройки (НЕ секреты) — localStorage. Секреты живут только в vault.
export type Prefs = {
  autolockMin: 0 | 5 | 15 | 30
  reduceMotion: boolean
  /**
   * Тянуть ли логотипы хостеров из интернета.
   *
   * По умолчанию НЕТ. Каждый такой запрос сообщает Google, у каких именно хостеров стоят
   * машины владельца, — а список провайдеров это часть приватной топологии, ровно как и
   * адреса, которые мы старательно не отправляем в гео-сервис. Цена отказа — монограмма
   * вместо картинки.
   */
  remoteLogos: boolean
}

const KEY = 'argus.prefs'

export function loadPrefs(): Prefs {
  try {
    return { autolockMin: 0, reduceMotion: false, remoteLogos: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { autolockMin: 0, reduceMotion: false, remoteLogos: false }
  }
}

/** Событие «настройки изменились» — слушатели (авто-лок) перечитывают prefs без polling. */
export const PREFS_EVENT = 'argus:prefs-changed'

export function savePrefs(p: Prefs): void {
  localStorage.setItem(KEY, JSON.stringify(p))
  document.documentElement.classList.toggle('reduce-motion', p.reduceMotion)
  window.dispatchEvent(new CustomEvent(PREFS_EVENT))
}
