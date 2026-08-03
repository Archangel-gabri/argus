// Экран AI: проверяем не вёрстку, а то, что он не врёт.
//
// Три вещи, из-за которых экран о деньгах опаснее любого другого: сумма «плачу в месяц» не
// должна включать непривязанные доступы; расход по подписке обязан быть подписан как
// эквивалент, а не как списанные деньги; неоформленный бесплатный доступ должен быть виден,
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
  costUsd: 42,
  ...over
})

async function mount(opts: { access: AiAccess[]; usage?: AiUsageDay[]; subs?: unknown[] }): Promise<void> {
  const api = {
    ai: {
      list: vi.fn().mockResolvedValue(opts.access),
      checks: vi.fn().mockResolvedValue([]),
      check: vi.fn().mockResolvedValue({ status: 'valid' }),
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

/**
 * Плитка сводки по её подписи.
 *
 * Берётся ПЕРВОЕ вхождение: те же слова встречаются и в карточке доступа, а сводка идёт выше.
 * И поднимаемся на родителя — подпись лежит внутри плитки отдельным элементом.
 */
const tile = (label: string): HTMLElement => screen.getAllByText(label)[0].parentElement as HTMLElement

const sub = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  name: 'Claude Max',
  provider: 'anthropic',
  category: 'AI',
  amount: 200,
  currency: 'USD',
  period: 'mo',
  nextRenewal: '2026-09-01',
  notes: null,
  manualRenewal: false,
  ...over
})

describe('экран AI', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.restoreAllMocks())

  it('раскладывает доступы по типам и не выдумывает пустые группы', async () => {
    await mount({
      access: [
        access('Claude Max', { kind: 'subscription', provider: 'anthropic' }),
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

  it('в «плачу в месяц» попадают только привязанные подписки', async () => {
    await mount({
      access: [
        access('Claude Max', { kind: 'subscription', subscriptionId: 's1' }),
        // Этот доступ денег не имеет: включи его в сумму — и цифра станет выдумкой.
        access('Groq', { kind: 'free-tier', payment: 'free', hasKey: false })
      ],
      subs: [sub()]
    })
    expect(within(tile('Плачу в месяц')).getByText('$200')).toBeInTheDocument()
  })

  it('годовая подписка приводится к месяцу, а не показывается как есть', async () => {
    await mount({
      access: [access('Годовая', { kind: 'subscription', subscriptionId: 's1' })],
      subs: [sub({ amount: 2400, period: 'yr' })]
    })
    expect(within(tile('Плачу в месяц')).getByText('$200')).toBeInTheDocument()
  })

  it('расход подписан как эквивалент по ценам API — это не списанные деньги', async () => {
    await mount({
      access: [access('Claude Max', { kind: 'subscription', provider: 'anthropic', subscriptionId: 's1' })],
      usage: [usageDay()],
      subs: [sub()]
    })
    const spend = tile('Сожжено за 30 дн.')
    expect(within(spend).getByText('$42')).toBeInTheDocument()
    expect(within(spend).getByText(/эквивалент по ценам API/)).toBeInTheDocument()
  })

  it('состояние «не оформлен» видно прямо в карточке', async () => {
    await mount({ access: [access('GitHub Copilot', { kind: 'subscription', status: 'planned', hasKey: false })] })
    expect(screen.getByText('не оформлен')).toBeInTheDocument()
  })

  it('пустой реестр предлагает завести первый доступ, а не показывает нули', async () => {
    await mount({ access: [] })
    expect(screen.getByText(/Доступов нет/)).toBeInTheDocument()
    // Ни одна плитка не должна утверждать «$0»: нечего считать — значит прочерк.
    expect(within(tile('Сожжено за 30 дн.')).getByText('—')).toBeInTheDocument()
  })

  it('доступ без ключа не выдаёт себя за проверенный', async () => {
    await mount({ access: [access('Локальная Ollama', { kind: 'local', hasKey: false, payment: 'free' })] })
    expect(screen.getByText('нет ключа')).toBeInTheDocument()
    expect(screen.getByText('бесплатно')).toBeInTheDocument()
  })
})
