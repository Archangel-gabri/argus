import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runAction, action, actionWith } from './action'
import { useToasts } from '@/store/toasts'

// Регрессия на целый класс, найденный линтером: 68 обработчиков вида
// `onClick={async () => { await api.что-то() }}`. Промис такого обработчика никому не
// принадлежит, отклонение уходит в «unhandled rejection», и человек не видит НИЧЕГО —
// нажал, и непонятно, сорвалось или медленно. На кнопке «перезагрузить сервер» это недопустимо.
describe('runAction', () => {
  beforeEach(() => useToasts.getState().clear())

  const toasts = (): ReturnType<typeof useToasts.getState>['toasts'] => useToasts.getState().toasts

  it('успех не поднимает шум', async () => {
    expect(await runAction(async () => ({ ok: true }), { failure: 'не вышло' })).toBe(true)
    expect(toasts()).toHaveLength(0)
  })

  it('брошенное исключение доходит до человека', async () => {
    const ok = await runAction(() => Promise.reject(new Error('соединение потеряно')), {
      failure: 'Не удалось перезагрузить'
    })
    expect(ok).toBe(false)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].kind).toBe('error')
    expect(toasts()[0].text).toBe('Не удалось перезагрузить')
    // Подробность от main не теряется: без неё непонятно, что именно случилось.
    expect(toasts()[0].detail).toBe('соединение потеряно')
  })

  it('ОТКАЗ, пришедший значением, считается неудачей — самый незаметный случай', async () => {
    // Слой IPC почти везде возвращает { ok: false }, а не бросает: await завершается успешно,
    // а операция не выполнена. Проверять это на каждом месте вызова забывают.
    const ok = await runAction(async () => ({ ok: false, error: 'нет прав' }), {
      failure: 'Не удалось выключить'
    })
    expect(ok).toBe(false)
    expect(toasts()[0].detail).toBe('нет прав')
  })

  it('успешный результат с ok:true неудачей не считается', async () => {
    expect(await runAction(async () => ({ ok: true, device: {} }), { failure: 'нет' })).toBe(true)
    expect(toasts()).toHaveLength(0)
  })

  it('результат без поля ok трактуется как успех — не всякий канал отвечает так', async () => {
    expect(await runAction(async () => ['одно', 'другое'], { failure: 'нет' })).toBe(true)
    expect(await runAction(async () => undefined, { failure: 'нет' })).toBe(true)
  })

  it('своя обработка заменяет сообщение — ошибку можно показать прямо в форме', async () => {
    const onError = vi.fn()
    await runAction(() => Promise.reject(new Error('пароль слабый')), {
      failure: 'Не удалось создать',
      onError
    })
    expect(onError).toHaveBeenCalledWith('пароль слабый')
    expect(toasts()).toHaveLength(0)
  })

  it('не-Error тоже описывается словами, а не «[object Object]»', async () => {
    await runAction(() => Promise.reject({ странное: true }), { failure: 'нет' })
    expect(toasts()[0].detail).toBe('неизвестная ошибка')
  })
})

describe('action — обработчик события', () => {
  beforeEach(() => useToasts.getState().clear())

  it('возвращает СИНХРОННУЮ функцию: именно этого ждёт React', () => {
    const handler = action(async () => ({ ok: true }), { failure: 'нет' })
    // Если бы обёртка возвращала промис, он снова остался бы бесхозным.
    expect(handler()).toBeUndefined()
  })

  it('отказ внутри обработчика становится видимым', async () => {
    const handler = action(() => Promise.reject(new Error('сервер не отвечает')), {
      failure: 'Не удалось подключиться'
    })
    handler()
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1))
    expect(useToasts.getState().toasts[0].text).toBe('Не удалось подключиться')
  })

  it('вариант с аргументом передаёт событие', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true })
    const handler = actionWith(fn, { failure: 'нет' })
    const event = { preventDefault: () => {} }
    handler(event)
    await vi.waitFor(() => expect(fn).toHaveBeenCalledWith(event))
  })
})

describe('хранилище сообщений', () => {
  beforeEach(() => useToasts.getState().clear())

  it('одинаковые сообщения не плодятся', () => {
    const s = useToasts.getState()
    s.push('error', 'Хост не отвечает', 'таймаут')
    s.push('error', 'Хост не отвечает', 'таймаут')
    s.push('error', 'Хост не отвечает', 'таймаут')
    // Пять неудачных опросов одного хоста не должны вытеснить с экрана всё остальное.
    expect(useToasts.getState().toasts).toHaveLength(1)
  })

  it('разные сообщения показываются раздельно', () => {
    const s = useToasts.getState()
    s.push('error', 'Первое')
    s.push('error', 'Второе')
    expect(useToasts.getState().toasts).toHaveLength(2)
  })

  it('больше пяти на экране не держится — иначе это шум, а не сообщения', () => {
    const s = useToasts.getState()
    for (let i = 0; i < 9; i++) s.push('info', `сообщение ${i}`)
    expect(useToasts.getState().toasts).toHaveLength(5)
    // Остаются САМЫЕ СВЕЖИЕ: старое уже прочитано или уже неактуально.
    expect(useToasts.getState().toasts[4].text).toBe('сообщение 8')
  })

  it('сообщение закрывается по идентификатору', () => {
    const id = useToasts.getState().push('info', 'закрой меня')
    useToasts.getState().dismiss(id)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })
})
