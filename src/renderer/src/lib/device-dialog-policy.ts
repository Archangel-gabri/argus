export type BootTarget = 'primary' | `alt:${number}`

export interface BootFields {
  bootEntry: string
  altOs: Array<{ bootEntry?: string }>
}

/** Назначить найденную EFI/GRUB-запись конкретной ОС, а не всегда основной. */
export function assignBootEntry<T extends BootFields>(fields: T, target: BootTarget, entry: string): T {
  if (target === 'primary') return { ...fields, bootEntry: entry }
  const index = Number(target.slice(4))
  if (!Number.isInteger(index) || index < 0 || index >= fields.altOs.length) return fields
  return {
    ...fields,
    altOs: fields.altOs.map((item, i) => (i === index ? { ...item, bootEntry: entry } : item))
  }
}

export function selectedBootEntry(fields: BootFields, target: BootTarget): string {
  if (target === 'primary') return fields.bootEntry
  const index = Number(target.slice(4))
  return fields.altOs[index]?.bootEntry ?? ''
}

/**
 * Пустые поля при правке означают «оставить зашифрованный секрет в main», а не «секрета нет».
 *
 * Имя намеренно НЕ начинается с `use`: это чистая функция, а не хук. Прежнее имя
 * (`useStoredProbe`) в React-коде читалось как обещание хука — и правило react-hooks честно
 * ругалось на её вызов внутри обычной функции. Имя должно говорить правду о природе значения.
 */
export function probesWithStoredSecret(
  editing: boolean,
  hasStoredSecret: boolean,
  typedPassword: string,
  typedKey: string
): boolean {
  return editing && hasStoredSecret && !typedPassword && !typedKey
}
