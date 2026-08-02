// Экран входа — единственная преграда между чужим человеком за клавиатурой и всем содержимым
// хранилища, и при этом единственный экран, который видит каждый запуск. Проверяем не вёрстку,
// а поведение: гейт на слабый пароль, доступность с клавиатуры и то, что введённое не
// разглашается ни в разметке, ни в сообщениях.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const vaultState = {
  status: 'uninitialized' as 'uninitialized' | 'locked' | 'unlocked',
  error: null as string | null,
  busy: false,
  keyringBackend: 'kwallet',
  initialize: vi.fn(),
  unlock: vi.fn(),
  refresh: vi.fn()
}

vi.mock('@/store/vault', () => ({ useVault: () => vaultState }))
vi.mock('@/assets/brand/argus-wordmark.png', () => ({ default: 'wordmark.png' }))

async function mount(over: Partial<typeof vaultState> = {}): Promise<void> {
  Object.assign(vaultState, over)
  vi.resetModules()
  const { LockScreen } = await import('./LockScreen')
  render(<LockScreen />)
}

describe('LockScreen — вход в существующее хранилище', () => {
  beforeEach(() => {
    Object.assign(vaultState, {
      status: 'locked',
      error: null,
      busy: false,
      initialize: vi.fn(),
      unlock: vi.fn(),
      refresh: vi.fn()
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('поле пароля скрывает ввод и подписано для програм чтения с экрана', async () => {
    await mount({ status: 'locked' })
    const field = await screen.findByLabelText(/пароль/i)
    expect(field).toHaveAttribute('type', 'password')
  })

  it('весь путь входа проходится одной клавиатурой', async () => {
    const user = userEvent.setup()
    const unlock = vi.fn()
    await mount({ status: 'locked', unlock })

    // Ни одного клика. Поле уже получило фокус само (autoFocus) — это и есть правильное
    // поведение экрана входа: человек начинает печатать сразу, не ища, куда нажать.
    const field = await screen.findByLabelText(/пароль/i)
    expect(document.activeElement).toBe(field)
    await user.keyboard('мой-мастер-пароль{Enter}')
    await waitFor(() => expect(unlock).toHaveBeenCalledWith('мой-мастер-пароль'))
  })

  it('ошибка входа объявляется, а не только подкрашивается', async () => {
    await mount({ status: 'locked', error: 'Invalid master password' })
    // Цвет рамки программа чтения с экрана не читает — нужна роль.
    const alert = await screen.findByRole('alert')
    expect(alert).toBeInTheDocument()
  })

  it('введённый пароль нигде не показывается открытым текстом', async () => {
    const user = userEvent.setup()
    await mount({ status: 'locked' })
    const field = await screen.findByLabelText(/пароль/i)
    await user.type(field, 'секрет-на-экране')

    // Именно видимый текст: подглядывание через плечо, скриншот и программа чтения с экрана
    // берут его. Атрибут value здесь не показатель — jsdom сериализует его иначе, чем браузер.
    expect(document.body.textContent).not.toContain('секрет-на-экране')
    expect(field).toHaveAttribute('type', 'password')
    // И пароль не уезжает в подсказку или заголовок соседних узлов.
    for (const el of document.querySelectorAll('[title],[aria-label],[placeholder]')) {
      const attrs = [el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('placeholder')]
      expect(attrs.join(' ')).not.toContain('секрет-на-экране')
    }
  })
})

describe('LockScreen — создание хранилища', () => {
  beforeEach(() => {
    Object.assign(vaultState, {
      status: 'uninitialized',
      error: null,
      busy: false,
      initialize: vi.fn(),
      unlock: vi.fn(),
      refresh: vi.fn()
    })
  })

  it('слабый пароль не даёт создать хранилище', async () => {
    const user = userEvent.setup()
    const initialize = vi.fn()
    await mount({ status: 'uninitialized', initialize })

    const fields = await screen.findAllByLabelText(/пароль/i)
    await user.type(fields[0], '123456')
    if (fields[1]) await user.type(fields[1], '123456')
    const submit = screen.getByRole('button', { name: /созда|продолж|войти/i })
    await user.click(submit)

    // Восстановления нет: слабый мастер-пароль — это потеря всего хранилища, а не неудобство.
    await waitFor(() => expect(initialize).not.toHaveBeenCalled())
  })

  it('предупреждение о невозможности восстановления показано до создания', async () => {
    await mount({ status: 'uninitialized' })
    expect(document.body.textContent).toMatch(/восстанов/i)
  })
})
