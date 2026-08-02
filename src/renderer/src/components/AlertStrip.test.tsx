// Полоса тревог — первый тест проекта `dom` (jsdom + Testing Library).
//
// Особенность компонента, из-за которой тест устроен именно так: `AlertStrip.tsx` читает
// `window.api` НА УРОВНЕ МОДУЛЯ, а не внутри эффекта. Значит подставить заглушку надо ДО
// импорта, поэтому импорт динамический. Это не придирка к тесту, а свойство кода: любой,
// кто вздумает подменить `window.api` после загрузки модуля, обнаружит, что его не слушают.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

interface Alert {
  key: string
  kind: string
  title: string
  body: string
  severity: 'warning' | 'critical'
}

const warning: Alert = {
  key: 'disk:node-1',
  kind: 'disk',
  title: 'Диск заканчивается',
  body: 'node-1 — занято 86%',
  severity: 'warning'
}
const critical: Alert = {
  key: 'down:node-2',
  kind: 'down',
  title: 'Машина не отвечает',
  body: 'node-2 молчит второй опрос подряд',
  severity: 'critical'
}

async function mount(alerts: Alert[]): Promise<void> {
  const list = vi.fn().mockResolvedValue(alerts)
  Object.defineProperty(window, 'api', { value: { alerts: { list } }, configurable: true })
  vi.resetModules()
  const { AlertStrip } = await import('./AlertStrip')
  render(<AlertStrip />)
  // Список приезжает промисом — ждём, пока эффект его разложит.
  await vi.waitFor(() => expect(list).toHaveBeenCalled())
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
    await mount([warning])
    expect(await screen.findByText('Диск заканчивается')).toBeInTheDocument()
    expect(screen.getByText('node-1 — занято 86%')).toBeInTheDocument()
  })

  it('срочное поднимает выше предупреждения независимо от порядка прихода', async () => {
    await mount([warning, critical])
    const titles = (await screen.findAllByText(/Диск заканчивается|Машина не отвечает/)).map(
      (n) => n.textContent
    )
    expect(titles).toEqual(['Машина не отвечает', 'Диск заканчивается'])
  })

  it('перечитывает список раз в минуту, а не чаще', async () => {
    vi.useFakeTimers()
    const list = vi.fn().mockResolvedValue([warning])
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
