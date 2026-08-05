// Полоса тревог — первый тест проекта `dom` (jsdom + Testing Library).
//
// Особенность компонента, из-за которой тест устроен именно так: `AlertStrip.tsx` читает
// `window.api` НА УРОВНЕ МОДУЛЯ, а не внутри эффекта. Значит подставить заглушку надо ДО
// импорта, поэтому импорт динамический. Это не придирка к тесту, а свойство кода: любой,
// кто вздумает подменить `window.api` после загрузки модуля, обнаружит, что его не слушают.
//
// Виды тревог здесь — НАСТОЯЩИЕ значения `AlertKind` из `src/main/alerts.ts`. Пока в тесте
// стояли выдуманные («disk», «down»), он проверял вёрстку и ничего не знал о том, какие строки
// на экран попадают, а какие нет, — то есть не защищал ровно то поведение, ради которого полоса
// и сделана.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

interface Alert {
  key: string
  kind: string
  title: string
  body: string
  severity: 'warning' | 'critical'
  deviceId?: string
}

const disk: Alert = {
  key: 'disk:node-1',
  kind: 'disk-full',
  title: 'node-1: диск занят на 86%',
  body: 'Место кончается — стоит освободить заранее.',
  severity: 'warning',
  deviceId: 'node-1'
}
const offline: Alert = {
  key: 'offline:node-2',
  kind: 'device-offline',
  title: 'node-2 не отвечает',
  body: 'Машина не отвечает на два опроса подряд.',
  severity: 'critical',
  deviceId: 'node-2'
}
const diskCritical: Alert = {
  key: 'disk:node-3',
  kind: 'disk-full',
  title: 'node-3: диск занят на 95%',
  body: 'Свободного места почти нет.',
  severity: 'critical',
  deviceId: 'node-3'
}
const renewal: Alert = {
  key: 'renewal:s1',
  kind: 'renewal-soon',
  title: 'OVH: продлить через 3 дн.',
  body: 'OVH: продление ручное, само не спишется.',
  severity: 'warning'
}
const credit: Alert = {
  key: 'ai-credit:a1',
  kind: 'ai-credit-low',
  title: 'OpenRouter: остаток $0.21',
  body: 'Баланс почти исчерпан.',
  severity: 'critical'
}
const keyDead: Alert = {
  key: 'ai-dead:a2',
  kind: 'ai-key-dead',
  title: 'DeepSeek: ключ не принимается',
  body: 'Провайдер отверг ключ.',
  severity: 'critical'
}

async function mount(alerts: Alert[]): Promise<void> {
  const list = vi.fn().mockResolvedValue(alerts)
  Object.defineProperty(window, 'api', { value: { alerts: { list } }, configurable: true })
  vi.resetModules()
  const { AlertStrip } = await import('./AlertStrip')
  render(<AlertStrip />)
  // Ждём не «вызвали ли `list`», а «применилось ли состояние». Разница решающая: вызов
  // происходит синхронно в эффекте, а строки появляются только после `.then`, — и любая
  // проверка ОТСУТСТВИЯ строки, сделанная в этом промежутке, проходит всегда и не проверяет
  // ничего. Прежний тест держался ровно на этом и пропускал полосу, показывающую всё подряд.
  await act(async () => {
    await list.mock.results[0]?.value
  })
}

describe('AlertStrip', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('без тревог не занимает место на экране', async () => {
    await mount([])
    // Именно ничего, а не пустая рамка: спокойное состояние не должно ничего сообщать.
    expect(document.body.querySelector('div > div')).toBeNull()
  })

  it('показывает и заголовок, и пояснение', async () => {
    await mount([disk])
    expect(await screen.findByText('node-1: диск занят на 86%')).toBeInTheDocument()
    expect(screen.getByText('Место кончается — стоит освободить заранее.')).toBeInTheDocument()
  })

  it('срочное поднимает выше предупреждения независимо от порядка прихода', async () => {
    await mount([disk, diskCritical])
    const titles = (await screen.findAllByText(/диск занят/)).map((n) => n.textContent)
    expect(titles).toEqual(['node-3: диск занят на 95%', 'node-1: диск занят на 86%'])
  })

  it('о выключенной машине строкой не сообщает', async () => {
    // Это же сказано меткой «Выключен» на карточке и счётчиком «N не отвечают» в шапке.
    // Третий голос об одном факте только удлиняет полосу — и ровно в тот момент, когда её надо
    // читать внимательнее всего. Диск в паре с ним нужен, чтобы отличить «строку отфильтровали»
    // от «полоса вообще ничего не успела нарисовать».
    await mount([offline, disk])
    expect(screen.getByText('node-1: диск занят на 86%')).toBeInTheDocument()
    expect(screen.queryByText('node-2 не отвечает')).toBeNull()
  })

  it('одна лишь выключенная машина не поднимает полосу вовсе', async () => {
    await mount([offline])
    expect(document.body.querySelector('div > div')).toBeNull()
  })

  it('тревоги чужих разделов не кричат, а сворачиваются в счётчик', async () => {
    // Остаток на счету и мёртвый ключ висят месяцами: закрыть их с экрана «Парк» нечем.
    // Цветная строка, которая горит всегда, приучает не читать полосу целиком.
    await mount([renewal, credit, keyDead])
    expect(screen.getByRole('button', { name: /Подписки 1/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ИИ 2/ })).toBeInTheDocument()
    expect(screen.queryByText('OpenRouter: остаток $0.21')).toBeNull()
    expect(screen.queryByText('OVH: продлить через 3 дн.')).toBeNull()
  })

  it('счётчик ведёт в тот раздел, где тревогу чинят', async () => {
    await mount([credit])
    // Стор берём ИЗ ТОГО ЖЕ реестра модулей, что и смонтированный компонент: `resetModules`
    // внутри `mount` создаёт новый экземпляр, и статический импорт наверху файла указывал бы
    // на другой стор — тест бы читал состояние, которого компонент не касался.
    const { useUI } = await import('@/store/ui')
    expect(useUI.getState().view).toBe('devices')
    await userEvent.click(await screen.findByRole('button', { name: /ИИ 1/ }))
    expect(useUI.getState().view).toBe('ai')
  })

  it('незнакомый вид тревоги показывает строкой, а не прячет', async () => {
    // Новое правило сторожа обязано быть видно сразу. Молчаливое исчезновение из-за того, что
    // вид забыли внести в разбор, — ошибка, которую невозможно заметить глазами.
    await mount([{ ...disk, kind: 'cert-expiring', title: 'Сертификат истекает' }])
    expect(await screen.findByText('Сертификат истекает')).toBeInTheDocument()
  })

  it('перечитывает список раз в минуту, а не чаще', async () => {
    vi.useFakeTimers()
    const list = vi.fn().mockResolvedValue([disk])
    Object.defineProperty(window, 'api', { value: { alerts: { list } }, configurable: true })
    vi.resetModules()
    const { AlertStrip } = await import('./AlertStrip')
    render(<AlertStrip />)
    expect(list).toHaveBeenCalledTimes(1)

    // Сторож считает раз в минуту — опрашивать чаще бессмысленно, ответ тот же.
    await vi.advanceTimersByTimeAsync(59_000)
    expect(list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(list).toHaveBeenCalledTimes(2)
  })
})
