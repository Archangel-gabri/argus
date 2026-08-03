// Экран AI: проверяем не вёрстку, а то, что он не врёт.
//
// Три вещи, из-за которых экран о деньгах опаснее любого другого: сумма «плачу» не должна
// включать непривязанные доступы и не должна смешивать валюты; расход по подписке обязан быть
// подписан как эквивалент, а не как списанные деньги; неоформленный доступ должен быть виден,
// а не выглядеть работающим.
//
// `window.api` читается модулями на уровне файла, поэтому заглушка ставится ДО импорта — как
// и в тесте полосы тревог.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { AiAccess, AiUsageDay } from '@/types'

const access = (id: string, over: Partial<AiAccess> = {}): AiAccess => ({
  id,
  kind: 'api',
  provider: 'openrouter',
  label: id,
  account: '',
  plan: '',
  status: 'active',
  subscriptionId: null,
  hasKey: true,
  keyRef: null,
  keyExpiresAt: null,
  baseUrl: null,
  payment: 'card',
  thirdParty: false,
  usedBy: [],
  fallbackId: null,
  limits: {},
  notes: null,
  createdAt: Date.parse('2026-01-01'),
  ...over
})

const usageDay = (over: Partial<AiUsageDay> = {}): AiUsageDay => ({
  date: new Date().toISOString().slice(0, 10),
  source: 'claude-code',
  model: 'claude-opus-5',
  input: 1000,
  output: 500,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 10000,
  requests: 3,
  costUsd: 4200,
  ...over
})

const sub = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  name: 'Claude Max 5x',
  provider: 'anthropic',
  category: 'AI',
  amount: 112.95,
  currency: 'EUR',
  period: 'mo',
  nextRenewal: '2026-08-20',
  notes: null,
  manualRenewal: false,
  ...over
})

async function mount(opts: { access: AiAccess[]; usage?: AiUsageDay[]; subs?: unknown[]; checks?: unknown[] }): Promise<void> {
  const api = {
    ai: {
      list: vi.fn().mockResolvedValue(opts.access),
      checks: vi.fn().mockResolvedValue(opts.checks ?? []),
      // Свежая проверка возвращает то же, что сохранённая: иначе она затрёт остаток, и тест
      // будет проверять не правило, а порядок двух запросов.
      check: vi.fn().mockImplementation(async (id: string) => {
        const saved = (opts.checks ?? []).find((c) => (c as { accessId: string }).accessId === id)
        return saved ?? { status: 'valid' }
      }),
      prices: vi.fn().mockResolvedValue([]),
      usage: vi.fn().mockResolvedValue({ days: opts.usage ?? [], collectedAt: Date.now(), scannedFiles: 0, skipped: 0 }),
      collect: vi.fn().mockResolvedValue({ files: 0, records: 0, duplicates: 0, unpriced: [] }),
      models: vi.fn().mockResolvedValue([])
    },
    subs: { list: vi.fn().mockResolvedValue(opts.subs ?? []) }
  }
  Object.defineProperty(window, 'api', { value: api, configurable: true })
  vi.resetModules()
  const { AIAccountsView } = await import('./AIAccountsView')
  render(<AIAccountsView />)
  await vi.waitFor(() => expect(api.ai.list).toHaveBeenCalled())
  await vi.waitFor(() => expect(api.ai.usage).toHaveBeenCalled())
}

/** Верхняя сводка — первый заголовок-контейнер экрана. */
const header = (): HTMLElement => document.querySelector('header') as HTMLElement

describe('экран AI', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('раскладывает доступы по типам и не выдумывает пустые группы', async () => {
    await mount({
      access: [
        access('Claude Max 5x', { kind: 'subscription', provider: 'anthropic' }),
        access('OpenRouter', { kind: 'router' }),
        access('NVIDIA NIM', { kind: 'free-tier', status: 'planned', hasKey: false })
      ]
    })
    expect(screen.getByRole('heading', { name: /Подписки/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Роутеры и реселлеры/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Бесплатные тарифы/ })).toBeInTheDocument()
    // Типа «Локальные» среди записей нет — и заголовка быть не должно.
    expect(screen.queryByRole('heading', { name: /Локальные/ })).not.toBeInTheDocument()
  })

  it('платёж показывается в валюте подписки, а не переводится в доллары', async () => {
    await mount({
      access: [access('Claude Max 5x', { kind: 'subscription', subscriptionId: 's1' })],
      subs: [sub()]
    })
    // €112,95 — ровно то, что списывает банк. Пересчёт в доллары дал бы «$122» и выглядел бы
    // как настоящая цифра, хотя курс здесь приблизительный.
    expect(within(header()).getByText(/112.95/)).toBeInTheDocument()
    expect(within(header()).queryByText(/\$113/)).not.toBeInTheDocument()
  })

  it('в сумму не попадают доступы без привязанной подписки', async () => {
    await mount({
      access: [
        access('Claude Max 5x', { kind: 'subscription', subscriptionId: 's1' }),
        access('Groq', { kind: 'free-tier', payment: 'free', hasKey: false })
      ],
      subs: [sub()]
    })
    expect(within(header()).getByText(/112.95/)).toBeInTheDocument()
  })

  it('годовая подписка приводится к месяцу', async () => {
    await mount({
      access: [access('Годовая', { kind: 'subscription', subscriptionId: 's1' })],
      subs: [sub({ amount: 1200, period: 'yr', currency: 'USD' })]
    })
    expect(within(header()).getByText(/\$100/)).toBeInTheDocument()
  })

  it('расход подписан как эквивалент по ценам API — это не списанные деньги', async () => {
    await mount({ access: [access('Claude', { provider: 'anthropic' })], usage: [usageDay()] })
    expect(within(header()).getByText(/по ценам API/)).toBeInTheDocument()
  })

  it('кончающийся баланс попадает в «требуют внимания»', async () => {
    // Иначе экран рапортует «0 проблем», пока строка рядом горит предупреждением об остатке
    // в двадцать центов.
    await mount({
      access: [access('OpenRouter', { kind: 'router' })],
      checks: [{ accessId: 'OpenRouter', status: 'valid', remaining: 0.21, usage: 19.79, detail: null, checkedAt: Date.now(), lastOkAt: Date.now() }]
    })
    expect(within(header()).getByText(/требует внимания/)).toBeInTheDocument()
  })

  it('панель справа показывает выбранный доступ, без модального окна', async () => {
    await mount({ access: [access('Claude Max 5x', { kind: 'subscription', provider: 'anthropic', account: 'me@example.com' })] })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getByRole('heading', { name: 'Claude Max 5x' })).toBeInTheDocument()
    // Тип записи в единственном числе: «anthropic · подписки» читается как ошибка.
    expect(within(panel).getByText(/anthropic · подписка/)).toBeInTheDocument()
    expect(within(panel).getByText('me@example.com')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('состояние «не оформлен» видно прямо в строке', async () => {
    await mount({ access: [access('GitHub Copilot', { kind: 'subscription', status: 'planned', hasKey: false })] })
    expect(screen.getAllByText('не оформлен').length).toBeGreaterThan(0)
  })

  it('пустой реестр предлагает завести первый доступ, а не показывает нули', async () => {
    await mount({ access: [] })
    expect(screen.getByText(/Доступов нет/)).toBeInTheDocument()
    // Ни одна цифра не должна утверждать «$0»: нечего считать — значит прочерк.
    expect(within(header()).getByText('—')).toBeInTheDocument()
    expect(within(header()).getByText('ничего')).toBeInTheDocument()
  })
})
