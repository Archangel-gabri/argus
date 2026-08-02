import { toastError, toastSuccess } from '@/store/toasts'

/**
 * Обёртка для асинхронных действий интерфейса.
 *
 * Проблема, которую она решает, звучит скучно, а стоит дорого. В React обработчик события
 * обязан возвращать `void`; если передать туда `async`-функцию, её промис никому не
 * принадлежит. Отклонение уходит в «unhandled rejection», интерфейс молчит, и человек не знает,
 * сорвалось действие или просто идёт медленно. На кнопке «Перезагрузить сервер» это
 * недопустимо.
 *
 * Здесь же решается вторая половина: отличить ОТКАЗ от ИСКЛЮЧЕНИЯ. Слой IPC в этом приложении
 * почти везде возвращает `{ ok: false, error }`, а не бросает, — то есть `await` завершается
 * успешно, а операция при этом не выполнена. Проверять это на каждом месте вызова забывают, и
 * именно так появляются кнопки, которые «нажимаются», ничего не делая.
 */

/** Ответ, каким его отдаёт main почти по всем каналам. */
export interface OkResult {
  ok: boolean
  error?: string
}

const isOkResult = (v: unknown): v is OkResult =>
  typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean'

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'неизвестная ошибка'

export interface RunOptions {
  /** Что написать человеку, если не получилось. Без этого сообщение бессмысленно. */
  failure: string
  /** Что написать, если получилось. Пусто — молчим: успех обычно виден по самому интерфейсу. */
  success?: string
  /** Своя обработка вместо сообщения — например, показать ошибку прямо в форме. */
  onError?: (message: string) => void
}

/**
 * Выполнить действие и ГАРАНТИРОВАННО сообщить об исходе.
 *
 * Возвращает true, только если действие действительно удалось: и промис разрешился, и
 * `{ ok: false }` не пришёл. Вызывающий может на это опереться.
 */
export async function runAction<T>(fn: () => Promise<T>, opts: RunOptions): Promise<boolean> {
  try {
    const result = await fn()
    // Отказ, пришедший значением, а не броском, — самый частый и самый незаметный случай.
    if (isOkResult(result) && !result.ok) {
      report(opts, result.error)
      return false
    }
    if (opts.success) toastSuccess(opts.success)
    return true
  } catch (e) {
    report(opts, messageOf(e))
    return false
  }
}

function report(opts: RunOptions, detail?: string): void {
  if (opts.onError) opts.onError(detail ?? opts.failure)
  else toastError(opts.failure, detail)
}

/**
 * Обработчик события из асинхронного действия.
 *
 * Возвращает синхронную функцию — ровно то, чего ждёт React, — поэтому промис перестаёт быть
 * бесхозным, а его отклонение доходит до человека.
 *
 * Было:  onClick={async () => { await api.pc.power(id, 'reboot') }}
 * Стало: onClick={action(() => api.pc.power(id, 'reboot'), { failure: 'Не удалось перезагрузить' })}
 */
export function action<T>(fn: () => Promise<T>, opts: RunOptions): () => void {
  return () => {
    void runAction(fn, opts)
  }
}

/** То же, но обработчик получает аргумент события (например, submit формы). */
export function actionWith<E, T>(
  fn: (event: E) => Promise<T>,
  opts: RunOptions
): (event: E) => void {
  return (event: E) => {
    void runAction(() => fn(event), opts)
  }
}
