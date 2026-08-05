// Форма устройства — единственное место, где человек своими руками задаёт всё, по чему потом
// идёт подключение: адрес, порт, учётку, секрет, загрузочную запись, соседние ОС. Ошибка здесь
// не видна на экране, она видна через сутки в виде «Argus не может зайти на машину».
//
// Проверяется не вёрстка, а договор формы: что уходит в хранилище после «Сохранить», что
// делают четыре кнопки-помощника (ИИ, гео, SSH-проба, чтение загрузочных записей) и что
// переход к ДРУГОМУ устройству не оставляет на экране ответов, полученных для прежнего.
//
// `window.api` читается модулями на уровне файла, поэтому заглушка ставится ДО импорта.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceDTO } from '@/types'

const device = (over: Partial<DeviceDTO> = {}): DeviceDTO => ({
  id: 'dev-1',
  name: 'Tokyo',
  provider: 'Hetzner',
  role: 'exit',
  kind: 'server',
  ip: '203.0.113.10',
  port: 22,
  user: 'root',
  country: 'Japan',
  flag: '🇯🇵',
  os: 'Ubuntu',
  status: 'online',
  cpu: 0,
  ram: { used: 0, total: 0 },
  cost: { amount: 5, currency: 'USD', usd: 5 },
  consoleUrl: '',
  authType: 'password',
  hasSecret: true,
  notes: null,
  jumpId: null,
  altOs: [],
  mac: null,
  ...over
})

function stubApi(): Record<string, Record<string, ReturnType<typeof vi.fn>>> {
  return {
    devices: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
      pickIcon: vi.fn().mockResolvedValue({ ok: false })
    },
    assist: {
      parseDevice: vi.fn().mockResolvedValue({
        ok: true,
        model: 'qwen2.5',
        fields: { name: 'Osaka', ip: '198.51.100.7', port: 2222, user: 'admin' }
      })
    },
    net: {
      ipLookup: vi
        .fn()
        .mockResolvedValue({ ok: true, country: 'Japan', city: 'Tokyo', flag: '🇯🇵', provider: 'Sakura', asn: 'AS7684' })
    },
    ssh: {
      probeHost: vi.fn().mockResolvedValue({ ok: true, os: 'Debian 12', hostname: 'osaka', cores: 4, ramTotal: 8 })
    },
    pc: {
      metrics: vi.fn().mockResolvedValue({ current: 'Ubuntu 24.04', family: 'linux', status: 'online', cpu: 12, ramTotal: 16 }),
      bootEntries: vi.fn().mockResolvedValue({
        ok: true,
        os: 'Linux',
        entries: [
          { id: '0001', label: 'ubuntu — \\EFI\\ubuntu\\shimx64.efi' },
          { id: '0002', label: 'Windows Boot Manager — \\EFI\\Microsoft\\Boot\\bootmgfw.efi' }
        ]
      })
    }
  }
}

type Api = ReturnType<typeof stubApi>

async function mount(open: 'new' | DeviceDTO, api: Api = stubApi()): Promise<{ api: Api; openEdit: (d: DeviceDTO) => void }> {
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  vi.resetModules()
  const { DeviceDialog } = await import('../DeviceDialog')
  const { useUI } = await import('@/store/ui')
  if (open === 'new') useUI.getState().openCreate()
  else useUI.getState().openEdit(open)
  render(<DeviceDialog />)
  return { api, openEdit: (d) => act(() => useUI.getState().openEdit(d)) }
}

const field = (name: RegExp): HTMLInputElement => screen.getByLabelText(name)
/** Поле записи основной ОС: имя носит и обрамляющая группа, поэтому спрашиваем именно поле ввода. */
const bootEntryInput = (): HTMLInputElement => screen.getByRole('textbox', { name: /^Загрузочная запись$/ })

describe('форма устройства — что уходит в хранилище', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('пустые поля превращаются в рабочие значения по умолчанию, а безымянная ОС не сохраняется', async () => {
    const user = userEvent.setup()
    const { api } = await mount('new')
    await user.type(field(/^Имя$/), 'Osaka')
    await user.clear(field(/^Порт$/))
    await user.clear(field(/^Пользователь SSH$/))
    // Вторая ОС без имени: сохранять её нельзя — переключение ушло бы в нечёткий поиск.
    await user.click(screen.getByRole('button', { name: /добавить ОС/ }))
    await user.type(screen.getByLabelText(/^Адрес ОС 2$/), '10.0.0.2')
    await user.click(screen.getByRole('button', { name: /^Добавить$/ }))
    await waitFor(() => expect(api.devices.create).toHaveBeenCalled())
    expect(api.devices.create.mock.calls[0][0]).toMatchObject({
      name: 'Osaka',
      provider: 'Custom',
      port: 22,
      user: 'root',
      altOs: []
    })
  })

  it('незаполненное имя не уходит в хранилище', async () => {
    const user = userEvent.setup()
    const { api } = await mount('new')
    await user.click(screen.getByRole('button', { name: /^Добавить$/ }))
    expect(api.devices.create).not.toHaveBeenCalled()
    expect(screen.getByText(/Укажи имя устройства/)).toBeInTheDocument()
  })

  it('начатую форму клик по подложке не уничтожает', async () => {
    const user = userEvent.setup()
    await mount('new')
    await user.type(field(/^Имя$/), 'Osaka')
    await user.click(document.querySelector('.fixed.inset-0') as HTMLElement)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('пустую форму клик по подложке закрывает', async () => {
    const user = userEvent.setup()
    await mount('new')
    await user.click(document.querySelector('.fixed.inset-0') as HTMLElement)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('форма устройства — кнопки-помощники', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('ИИ раскладывает вставленный текст по полям и отчитывается, сколько заполнил', async () => {
    const user = userEvent.setup()
    const { api } = await mount('new')
    await user.type(screen.getByLabelText(/Текст для локального заполнения/), 'ssh admin@198.51.100.7 -p 2222')
    await user.click(screen.getByRole('button', { name: /Заполнить/ }))
    await waitFor(() => expect(api.assist.parseDevice).toHaveBeenCalledWith('ssh admin@198.51.100.7 -p 2222'))
    expect(field(/^Имя$/).value).toBe('Osaka')
    expect(field(/^Порт$/).value).toBe('2222')
    expect(await screen.findByText(/заполнено полей: 4 · qwen2.5/)).toBeInTheDocument()
  })

  it('гео по IP заполняет страну, флаг и пустого хостера', async () => {
    const user = userEvent.setup()
    const { api } = await mount('new')
    await user.type(field(/^Адрес$/), '198.51.100.7')
    await user.click(screen.getByRole('button', { name: /Гео по IP/ }))
    await waitFor(() => expect(api.net.ipLookup).toHaveBeenCalledWith('198.51.100.7'))
    expect(field(/^Страна$/).value).toBe('Japan · Tokyo')
    expect(field(/^Флаг$/).value).toBe('🇯🇵')
    expect(field(/^Хостер \/ владелец$/).value).toBe('Sakura')
  })

  it('SSH-проба нового устройства идёт по введённым данным', async () => {
    const user = userEvent.setup()
    const { api } = await mount('new')
    await user.type(field(/^Адрес$/), '198.51.100.7')
    await user.type(screen.getByLabelText(/^Пароль SSH$/), 'hunter2')
    await user.click(screen.getByRole('button', { name: /Определить по SSH/ }))
    await waitFor(() => expect(api.ssh.probeHost).toHaveBeenCalled())
    expect(api.ssh.probeHost.mock.calls[0][0]).toMatchObject({
      host: '198.51.100.7',
      port: 22,
      user: 'root',
      password: 'hunter2'
    })
    // Поле ОС спрашивается ПО ПОДПИСИ — как его находит и программа чтения с экрана. Рядом с
    // ним лежит datalist с подсказками, и пока подпись доставалась обрамляющей группе, поле
    // оставалось безымянным: заметить это можно было только с включённым диктором.
    // Первое поле — основной ОС; такие же есть у каждой доп. системы в списке ниже.
    expect(screen.getAllByLabelText<HTMLInputElement>(/Операционная система/i)[0].value).toBe('Debian 12')
    expect(field(/^Имя$/).value).toBe('osaka')
  })

  it('при правке с сохранённым секретом проба идёт по id — секрет остаётся в main', async () => {
    const user = userEvent.setup()
    const { api } = await mount(device())
    await user.click(screen.getByRole('button', { name: /Определить по SSH/ }))
    await waitFor(() => expect(api.pc.metrics).toHaveBeenCalledWith('dev-1'))
    expect(api.ssh.probeHost).not.toHaveBeenCalled()
    expect(await screen.findByText(/Ubuntu 24.04 · CPU 12/)).toBeInTheDocument()
  })

  it('изменённый адрес не проверяется старым секретом', async () => {
    const user = userEvent.setup()
    const { api } = await mount(device())
    await user.clear(field(/^Адрес$/))
    await user.type(field(/^Адрес$/), '198.51.100.7')
    await user.click(screen.getByRole('button', { name: /Определить по SSH/ }))
    expect(await screen.findByText(/сначала сохрани/)).toBeInTheDocument()
    expect(api.pc.metrics).not.toHaveBeenCalled()
    expect(api.ssh.probeHost).not.toHaveBeenCalled()
  })
})

describe('форма устройства — загрузочные записи и соседние ОС', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('прочитанная запись назначается той ОС, которая выбрана целью', async () => {
    const user = userEvent.setup()
    const { api } = await mount(device({ kind: 'pc', altOs: [{ os: 'Windows 11', ip: '10.0.0.5', user: 'danya' }] }))
    await user.click(screen.getByRole('button', { name: /Спросить машину/ }))
    await waitFor(() => expect(api.pc.bootEntries).toHaveBeenCalledWith('dev-1'))
    expect(await screen.findByText(/найдено записей: 2/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /shimx64/ }))
    expect(bootEntryInput().value).toBe('0001')

    await user.selectOptions(screen.getByLabelText(/Целевая ОС для загрузочной записи/), 'alt:0')
    await user.click(screen.getByRole('button', { name: /bootmgfw/ }))
    expect(screen.getByLabelText<HTMLInputElement>(/Загрузочная запись для ОС 2/).value).toBe('0002')
    // Запись основной ОС при этом не тронута.
    expect(bootEntryInput().value).toBe('0001')
  })

  it('удаление соседней ОС возвращает цель к основной — индексы съезжают', async () => {
    const user = userEvent.setup()
    await mount(device({ kind: 'pc', altOs: [{ os: 'Windows 11', ip: '10.0.0.5', user: 'danya' }] }))
    await user.click(screen.getByRole('button', { name: /Спросить машину/ }))
    await screen.findByText(/найдено записей: 2/)
    await user.selectOptions(screen.getByLabelText(/Целевая ОС для загрузочной записи/), 'alt:0')
    await user.click(screen.getByRole('button', { name: /Удалить ОС/ }))
    expect(screen.getByLabelText<HTMLSelectElement>(/Целевая ОС для загрузочной записи/).value).toBe('primary')
  })

  it('соседняя ОС сохраняется вместе со своим портом и записью', async () => {
    const user = userEvent.setup()
    const { api } = await mount(device({ kind: 'pc' }))
    await user.click(screen.getByRole('button', { name: /добавить ОС/ }))
    await user.type(screen.getByLabelText(/^ОС 2$/), 'Windows 11')
    await user.type(screen.getByLabelText(/^Адрес ОС 2$/), '10.0.0.5')
    await user.clear(screen.getByLabelText(/Пользователь ОС 2/))
    await user.type(screen.getByLabelText(/Порт SSH для ОС 2/), '2200')
    await user.type(screen.getByLabelText(/Загрузочная запись для ОС 2/), '0002')
    await user.click(screen.getByRole('button', { name: /^Сохранить$/ }))
    await waitFor(() => expect(api.devices.update).toHaveBeenCalled())
    expect(api.devices.update.mock.calls[0][1]).toMatchObject({
      altOs: [{ os: 'Windows 11', ip: '10.0.0.5', user: 'root', port: 2200, bootEntry: '0002' }]
    })
  })
})

describe('форма устройства — переход к другому устройству', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('ответы, полученные для прежней машины, не остаются на экране', async () => {
    const user = userEvent.setup()
    const { openEdit } = await mount(device({ kind: 'pc' }))
    await user.click(screen.getByRole('button', { name: /Спросить машину/ }))
    await screen.findByText(/найдено записей: 2/)
    await user.click(screen.getByRole('button', { name: /Определить по SSH/ }))
    await screen.findByText(/Ubuntu 24.04 · CPU 12/)

    openEdit(device({ id: 'dev-2', name: 'Osaka', ip: '198.51.100.7', kind: 'pc' }))
    await waitFor(() => expect(field(/^Имя$/).value).toBe('Osaka'))
    expect(screen.queryByText(/найдено записей/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Ubuntu 24.04 · CPU 12/)).not.toBeInTheDocument()
    expect(field(/^Адрес$/).value).toBe('198.51.100.7')
  })
})
describe('устройство без сохранённой авторизации', () => {
  it('открывается с выбранным способом входа, а не в подвешенном состоянии', async () => {
    // Такие записи заводит импорт `~/.ssh/config`: способ входа там не указан. Тумблер знает
    // два значения, тип — три, и запись с `none` открывалась без нажатой кнопки, но с полями
    // ключа на экране; проба по SSH при этом была навсегда выключена.
    await mount(device({ authType: 'none', hasSecret: false }))

    const byPassword = screen.getByRole('button', { name: 'Пароль' })
    expect(byPassword).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'SSH-ключ' })).toHaveAttribute('aria-pressed', 'false')
    // И поле показывается то, которое соответствует выбранному способу.
    expect(screen.getByPlaceholderText('хранится в зашифрованном виде')).toBeInTheDocument()
  })
})
