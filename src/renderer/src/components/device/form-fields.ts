import type { AuthType, Currency, DeviceDTO, DeviceKind, Status } from '@/types'

/** Общий вид полей ввода формы устройства — им пользуются и сама форма, и её блоки. */
export const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'

export interface FormFields {
  name: string
  provider: string
  kind: DeviceKind
  ip: string
  port: string
  user: string
  os: string
  country: string
  flag: string
  status: Status
  amount: string
  currency: Currency
  consoleUrl: string
  authMethod: AuthType
  password: string
  privateKey: string
  passphrase: string
  jumpId: string
  // bootEntry — точная запись GRUB для boot-switch; в UI не показываем, но СОХРАНЯЕМ при правке
  // (иначе grub-reboot сваливается в нечёткий поиск по ключевому слову → не та ОС).
  altOs: Array<{ os: string; ip: string; user: string; bootEntry?: string; port?: number }>
  mac: string
  role: string
  notes: string
  /** Загрузочная запись основной ОС — ею переключение выбирает цель. */
  bootEntry: string
  /** Портрет: ключ встроенного изображения, data-URL своей картинки или '' = авто. */
  icon: string
}

/**
 * Правка полей формы. Блоки-помощники (ИИ, гео, SSH-проба, загрузочные записи, соседние ОС)
 * дописывают своё тем же способом, что и сама форма, — через функцию от прежних значений:
 * два ответа, пришедшие один за другим, не должны затирать друг друга.
 */
export type FillFields = (update: (prev: FormFields) => FormFields) => void

export const EMPTY: FormFields = {
  name: '', provider: '', kind: 'server', ip: '', port: '22', user: 'root', os: '', country: '', flag: '',
  status: 'unknown', amount: '', currency: 'USD', consoleUrl: '',
  authMethod: 'password', password: '', privateKey: '', passphrase: '', jumpId: '', altOs: [], mac: '',
  role: '', notes: '', bootEntry: '', icon: ''
}

/**
 * Поля формы для уже заведённого устройства.
 *
 * Пароль и ключ намеренно остаются пустыми: секрет лежит зашифрованным в main и через IPC не
 * ходит, а пустое поле при правке означает «оставить сохранённый».
 */
export function fieldsOf(d: DeviceDTO): FormFields {
  return {
    name: d.name, provider: d.provider, kind: d.kind, ip: d.ip, port: String(d.port), user: d.user, os: d.os,
    country: d.country, flag: d.flag, status: d.status,
    amount: d.cost.amount ? String(d.cost.amount) : '', currency: d.cost.currency,
    consoleUrl: d.consoleUrl, authMethod: d.authType,
    password: '', privateKey: '', passphrase: '', jumpId: d.jumpId ?? '',
    altOs: d.altOs.map((a) => ({ os: a.os, ip: a.ip, user: a.user, bootEntry: a.bootEntry, port: a.port })), mac: d.mac ?? '',
    role: d.role ?? '', notes: d.notes ?? '', bootEntry: d.bootEntry ?? '', icon: d.icon ?? ''
  }
}
