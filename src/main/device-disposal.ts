/**
 * Отзыв всех живых возможностей ОДНОГО устройства.
 *
 * Раньше удаление устройства гасило только проброс-туннели, а запись в хранилище исчезала.
 * Терминал, файловая сессия и трансляция продолжали работать по уже открытым соединениям:
 * устройства в приложении нет, а доступ к машине есть — и закрыть его нечем, потому что
 * закрывать не по чему. Удаление обязано отзывать доступ, а не только прятать строку из списка.
 *
 * Модуль намеренно чистый (как `lockdown-policy`): здесь только порядок и устойчивость к
 * частичному отказу, а сами закрыватели приходят снаружи — так это проверяется без Electron,
 * SSH и хранилища.
 */
export interface DeviceDisposalActions {
  /** Терминалы устройства. */
  closeShells: (deviceId: string) => number
  /** Файловые сессии устройства. */
  closeSftp: (deviceId: string) => number
  /** Проброс-туннели устройства (иначе localhost-листенер продолжает туннелировать). */
  closeForwards: (deviceId: string) => number
  /** Окна трансляции устройства. */
  closeScreens: (deviceId: string) => number
}

/** Что именно закрывали — по видам ресурса. */
export type DisposalKind = 'screens' | 'shells' | 'sftp' | 'forwards'

export type DisposalReport = Record<DisposalKind, number> & {
  /** Виды, закрытие которых упало. Пустой массив — всё отозвано штатно. */
  failed: DisposalKind[]
}

export function disposeDevice(deviceId: string, actions: DeviceDisposalActions): DisposalReport {
  const report: DisposalReport = { screens: 0, shells: 0, sftp: 0, forwards: 0, failed: [] }

  // Каждый шаг изолирован: одно уже сломанное соединение не должно оставить остальные жить.
  // Порядок — от самого заметного к тихому, чтобы человек сразу видел, что доступ закрыт.
  const steps: Array<[DisposalKind, (id: string) => number]> = [
    ['screens', actions.closeScreens],
    ['shells', actions.closeShells],
    ['sftp', actions.closeSftp],
    ['forwards', actions.closeForwards]
  ]

  for (const [kind, step] of steps) {
    try {
      report[kind] = step(deviceId)
    } catch {
      report.failed.push(kind)
    }
  }
  return report
}

/** Остался ли хоть один живой ресурс после отзыва — то есть удалять запись ещё нельзя. */
export const disposalClean = (r: DisposalReport): boolean => r.failed.length === 0
