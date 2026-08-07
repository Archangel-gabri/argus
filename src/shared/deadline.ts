// Срок на операцию, которую можно отменить.
//
// Проблема, которую это решает, дороже, чем кажется. Почти все удалённые операции в приложении
// построены на обратных вызовах: `client.shell(cb)`, `sftp.readdir(cb)`, `server.listen(cb)`.
// Если канал «почернел» — соединение живо, но данные не идут, — вызов не приходит НИКОГДА.
// Промис не завершается, интерфейс остаётся в «Загрузка…» до перезапуска приложения.
//
// Обычного `Promise.race` мало, и это главное здесь. Гонка освободит того, кто ждёт, но не
// остановит источник: поздний вызов всё равно придёт и всё равно сделает своё дело — заведёт
// сессию, которой уже никто не владеет, зарегистрирует туннель, переименует временный файл
// поверх настоящего. Поэтому нужен не таймер рядом, а ворота:
//
//   1) срок сначала АТОМАРНО забирает право завершить операцию,
//   2) потом отменяет источник,
//   3) и только потом сообщает об ошибке.
//
// В таком порядке отмена, породившая синхронное событие `close`, уже видит закрытые ворота — и
// сообщение о сроке не подменяется сообщением о закрытии.
//
// Всё, что должно случиться при успехе (запись в карту сессий, подписка на события окна,
// сохранение в хранилище), кладётся ВНУТРЬ `settle` — тогда поздний вызов этого не сделает.

export class DeadlineError extends Error {
  readonly code = 'ARGUS_DEADLINE'
  /**
   * `what` — что именно не дождались, словами человека. Без него сообщение выходило про
   * механику («операция не уложилась в 20 с»), а человеку нужно понять, что делать: «сервер не
   * ответил» и «файл не передаётся» — разные новости, хотя внутри это один и тот же срок.
   */
  constructor(
    readonly ms: number,
    what?: string
  ) {
    super(what ? `${what} за ${Math.round(ms / 1000)} с` : `операция не уложилась в ${Math.round(ms / 1000)} с`)
    this.name = 'DeadlineError'
  }
}

export interface DeadlineGate<T> {
  /**
   * Ещё не поздно? Спрашивать перед КАЖДЫМ промежуточным действием и перед запуском следующей
   * фазы обратных вызовов: `realpath` мог прийти вовремя, а срок истечь до `readdir`.
   */
  active(): boolean

  /**
   * Завершить успехом. Сначала забирает право завершить, потом выполняет `commit`.
   *
   * `discardLate` вызывается, если право уже забрал срок: сюда идёт утилизация того, что
   * появилось только в позднем вызове (поток, сессия, дескриптор). Возвращает `true`, если
   * успех засчитан.
   */
  settle(commit: () => T, discardLate?: () => void): boolean

  /** То же для отказа. Поздний отказ игнорируется — ошибку про срок он бы только затёр. */
  reject(error: unknown, discardLate?: () => void): boolean
}

export function withDeadline<T>(options: {
  ms: number
  run: (gate: DeadlineGate<T>) => void | Promise<void>
  /** Отмена источника: синхронная, идемпотентная, без ожидания. */
  dispose: (error: DeadlineError) => void
  /** Что не дождались — попадёт в сообщение, которое прочитает человек. */
  what?: string
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const take = (): boolean => {
      if (settled) return false
      settled = true
      return true
    }

    // Таймер ставится ДО запуска работы: иначе синхронный обратный вызов внутри `run` успел бы
    // завершить операцию раньше, чем срок вообще начал идти, и `clearTimeout` промахнулся бы.
    const timer = setTimeout(() => {
      if (!take()) return
      const error = new DeadlineError(options.ms, options.what)
      try {
        // Отмена идёт ПОСЛЕ того, как право забрано: если она синхронно породит `close` или
        // `error`, обработчик увидит закрытые ворота и не подменит причину отказа.
        options.dispose(error)
      } catch {
        // Отмена не обязана удаться (дескриптор уже мёртв) — на причину отказа это не влияет.
      }
      reject(error)
    }, options.ms)
    // В основном процессе висящий таймер не должен удерживать приложение при выходе.
    ;(timer as unknown as { unref?: () => void }).unref?.()

    const gate: DeadlineGate<T> = {
      active: () => !settled,
      settle(commit, discardLate) {
        if (!take()) {
          discardLate?.()
          return false
        }
        clearTimeout(timer)
        try {
          resolve(commit())
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
        return true
      },
      reject(cause, discardLate) {
        if (!take()) {
          discardLate?.()
          return false
        }
        clearTimeout(timer)
        // Причиной отказа бывает что угодно (обратные вызовы ssh2 отдают и строки). Наружу
        // выдаём Error: иначе разбор ошибки у вызывающего зависит от того, кто её бросил.
        reject(cause instanceof Error ? cause : new Error(String(cause)))
        return true
      }
    }

    try {
      const maybe = options.run(gate)
      // `run` может быть асинхронным: его отказ обязан завершить операцию, а не уйти в никуда.
      if (maybe && typeof maybe.catch === 'function') {
        void maybe.catch((error: unknown) => gate.reject(error))
      }
    } catch (error) {
      gate.reject(error)
    }
  })
}
