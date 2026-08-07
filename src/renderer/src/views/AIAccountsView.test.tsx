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
  accounts: [],
  channels: [],
  verified: true,
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

async function mount(opts: {
  access: AiAccess[]
  usage?: AiUsageDay[]
  subs?: unknown[]
  checks?: unknown[]
  blocks?: unknown[]
  quotas?: unknown[]
}): Promise<void> {
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
      usage: vi
        .fn()
        .mockResolvedValue({ days: opts.usage ?? [], blocks: opts.blocks ?? [], collectedAt: Date.now(), scannedFiles: 0, skipped: 0 }),
      collect: vi.fn().mockResolvedValue({ files: 0, records: 0, duplicates: 0, unpriced: [] }),
      models: vi.fn().mockResolvedValue([]),
      quotas: vi.fn().mockResolvedValue(opts.quotas ?? [])
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

  it('группирует по деньгам, а не по типу записи', async () => {
    // Владелец думает «за что плачу / где кончается / что бесплатно / что ещё не взял», а не
    // «роутер это или ключ». Прежняя разбивка рассыпала один провайдер по трём полкам.
    await mount({
      access: [
        access('Claude Max 5x', { kind: 'subscription', provider: 'anthropic', subscriptionId: 's1' }),
        access('OpenRouter', { kind: 'router' }),
        access('Ollama', { kind: 'local', payment: 'free' }),
        access('NVIDIA NIM', { kind: 'free-tier', status: 'planned', hasKey: false })
      ],
      subs: [sub()]
    })
    expect(screen.getByRole('heading', { name: /Плачу/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Балансы/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Бесплатные/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Можно взять/ })).toBeInTheDocument()
  })

  it('неоформленные не считаются доступами', async () => {
    // «14 доступов», из которых четырёх не существует, — это ложь инвентаря.
    await mount({
      access: [
        access('Живой', { kind: 'api' }),
        access('NVIDIA NIM', { kind: 'free-tier', status: 'planned', hasKey: false })
      ]
    })
    expect(within(header()).getByText(/1 можно взять/)).toBeInTheDocument()
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

  it('две записи на одну подписку платятся один раз', async () => {
    // Один аккаунт ходит несколькими каналами: «Claude Max» в браузере и «Claude Code» в
    // терминале — это одна оплата. Обе записи законно ссылаются на одну строку подписки, а
    // цикл по записям складывал её дважды: 112,95 превращались в 225,90. Ради этого деньги и
    // держат только в subscriptions — цифра выглядела бы достоверной и была бы вдвое неверной.
    await mount({
      access: [
        access('Claude Max 5x', { kind: 'subscription', provider: 'anthropic', subscriptionId: 's1' }),
        access('Claude Code', { kind: 'cli-agent', provider: 'anthropic', subscriptionId: 's1' })
      ],
      subs: [sub()]
    })
    expect(within(header()).getByText(/112.95/)).toBeInTheDocument()
    expect(within(header()).queryByText(/225/)).not.toBeInTheDocument()
  })

  it('задуманный доступ денег не стоит, даже если подписка к нему привязана', async () => {
    // Статус planned значит «ещё не оформлен». Его подписка в «плачу» попадать не должна:
    // соседний счётчик доступов такую запись уже отбрасывает, а сумма — нет.
    await mount({
      access: [
        access('Claude Max 5x', { kind: 'subscription', subscriptionId: 's1' }),
        access('Задумано', { kind: 'subscription', status: 'planned', hasKey: false, subscriptionId: 's2' })
      ],
      subs: [sub(), sub({ id: 's2', name: 'Задумано', amount: 500, currency: 'EUR' })]
    })
    expect(within(header()).getByText(/112.95/)).toBeInTheDocument()
    expect(within(header()).queryByText(/612/)).not.toBeInTheDocument()
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

  it('кончающийся баланс виден в самой строке, а не полосой сверху', async () => {
    // Полоса «требуют внимания» убрана вместе с остальными уведомлениями: владелец просил
    // экран, который показывает состояние, а не окликает. Состояние при этом не потерялось —
    // оно там, где ему место: у самой записи, рядом с её именем и остатком.
    await mount({
      access: [access('OpenRouter', { kind: 'router' })],
      checks: [{ accessId: 'OpenRouter', status: 'valid', remaining: 0.21, usage: 19.79, detail: null, checkedAt: Date.now(), lastOkAt: Date.now() }]
    })
    expect(screen.queryByText(/требуют внимания|— пополнить/)).toBeNull()
    // Сам остаток на месте: он и есть предупреждение.
    expect(screen.getAllByText(/0[.,]21/).length).toBeGreaterThan(0)
  })

  it('страница доступа открыта рядом со списком, без модального окна', async () => {
    await mount({ access: [access('Claude Max 5x', { kind: 'subscription', provider: 'anthropic', account: 'me@example.com' })] })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getByRole('heading', { name: 'Claude Max 5x' })).toBeInTheDocument()
    // Тип записи в единственном числе: «подписки» про одну запись читается как ошибка.
    expect(within(panel).getByText('подписка')).toBeInTheDocument()
    expect(within(panel).getByText('anthropic')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('данные собираются сами — кнопок «пересчитать» и «взять пароли» нет', async () => {
    // Кнопка, которую надо нажимать при каждом входе, — это не функция, а недоделанная
    // автоматика: логи, пароли и списки моделей обновляются в фоне при открытии хранилища.
    await mount({ access: [access('Claude', { provider: 'anthropic' })] })
    expect(screen.queryByRole('button', { name: /Пересчитать/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Пароли/ })).not.toBeInTheDocument()
  })

  it('окно лимита показывает процент только когда потолок задан', async () => {
    const now = Date.now()
    const block = { source: 'claude-code', startTs: now - 3 * 3600_000, endTs: now + 2 * 3600_000, tokens: 570_000, costUsd: 12, requests: 40 }

    await mount({
      access: [access('Claude', { provider: 'anthropic', limits: { windowHours: 5, windowTokens: 1_000_000 } })],
      blocks: [block]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getByText('57%')).toBeInTheDocument()
    expect(within(panel).getByText(/сбросится через 2 ч/i)).toBeInTheDocument()
  })

  it('без заданного потолка доля считается от наблюдаемого максимума и помечается оценкой', async () => {
    // Провайдеры порогов не публикуют, но история владельца показывает, сколько лимит точно
    // позволял. Считать от неё можно — выдавать за настоящий лимит нельзя, поэтому «≈».
    const now = Date.now()
    const H = 3600_000
    await mount({
      access: [access('Claude', { provider: 'anthropic', limits: { windowHours: 5 } })],
      blocks: [
        { source: 'claude-code', startTs: now - 30 * H, endTs: now - 25 * H, tokens: 1_000_000, costUsd: 20, requests: 90 },
        { source: 'claude-code', startTs: now - H, endTs: now + 4 * H, tokens: 500_000, costUsd: 10, requests: 40 }
      ]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getByText('≈50%')).toBeInTheDocument()
    expect(within(panel).getAllByText(/наблюдаемый максимум/).length).toBeGreaterThan(0)
  })

  it('без истории мерить не от чего — процента нет вовсе', async () => {
    const now = Date.now()
    await mount({
      access: [access('Claude', { provider: 'anthropic', limits: { windowHours: 5 } })],
      blocks: [{ source: 'claude-code', startTs: now - 3600_000, endTs: now + 4 * 3600_000, tokens: 0, costUsd: 0, requests: 0 }]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).queryByText(/%/)).not.toBeInTheDocument()
  })

  it('аккаунты провайдера перечислены с тарифом каждого', async () => {
    // «6 аккаунтов» не отвечает на вопрос, где лежит платная подписка, — а именно его и задают.
    await mount({
      access: [
        access('ChatGPT', {
          provider: 'openai',
          accounts: [
            { email: 'main@example.com', plan: 'free', primary: true },
            { email: 'second@example.com', plan: 'Plus' }
          ]
        })
      ]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getByText(/Аккаунты · 2/)).toBeInTheDocument()
    expect(within(panel).getByText('main@example.com')).toBeInTheDocument()
    expect(within(panel).getByText('Plus')).toBeInTheDocument()
    expect(within(panel).getByText('основной')).toBeInTheDocument()
  })

  it('состояние «не оформлен» видно прямо в строке', async () => {
    await mount({ access: [access('GitHub Copilot', { kind: 'subscription', status: 'planned', hasKey: false })] })
    expect(screen.getAllByText('не оформлен').length).toBeGreaterThan(0)
  })

  it('расход достаётся одной записи, а не всем записям провайдера', async () => {
    // Иначе одни и те же токены Claude Code показываются как свои у подписки, у ключа и у
    // второго ключа — цифра выглядит достоверной и является неправдой.
    await mount({
      access: [
        access('Claude Max', { kind: 'subscription', provider: 'anthropic', usedBy: ['Claude Code'], createdAt: 1 }),
        access('Ключ Anthropic', { kind: 'api', provider: 'anthropic', createdAt: 2 })
      ],
      usage: [usageDay()]
    })
    // На первой записи расход есть.
    expect(within(document.querySelector('aside') as HTMLElement).getByText(/Расход Claude Code/)).toBeInTheDocument()

    // На второй — блока расхода нет вовсе.
    const rows = screen.getAllByRole('button').filter((b) => b.textContent?.includes('Ключ Anthropic'))
    rows[0].click()
    await vi.waitFor(() =>
      expect(within(document.querySelector('aside') as HTMLElement).queryByText(/Расход Claude Code/)).not.toBeInTheDocument()
    )
  })

  it('пустой реестр предлагает завести первый доступ, а не показывает нули', async () => {
    await mount({ access: [] })
    expect(screen.getByText(/Доступов нет/)).toBeInTheDocument()
    // Ни одна цифра не должна утверждать «$0»: нечего считать — значит прочерк.
    expect(within(header()).getByText('—')).toBeInTheDocument()
    expect(within(header()).getByText('ничего')).toBeInTheDocument()
  })
})

describe('квота от провайдера', () => {
  const slice = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    accessId: 'Claude',
    scope: 'session',
    label: 'Текущая сессия',
    ratio: 0.24,
    used: null,
    limit: null,
    unit: '%',
    resetsAt: Date.now() + 100 * 60_000,
    plan: null,
    model: null,
    checkedAt: Date.now(),
    ...over
  })

  it('доля провайдера показывается точной — без «≈»', async () => {
    // Эту цифру считает сам аккаунт: она включает телефон и второй ноутбук владельца, а не
    // только эту машину. Помечать её оценкой значило бы приравнять измерение к догадке.
    await mount({
      access: [access('Claude', { provider: 'anthropic', limits: { windowHours: 5 } })],
      quotas: [slice()]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getByText('24%')).toBeInTheDocument()
    expect(within(panel).queryByText('≈24%')).not.toBeInTheDocument()
  })

  it('своя оценка за тот же период рядом не показывается', async () => {
    // Два разных ответа на один вопрос рядом читаются как ошибка — и читаются правильно.
    const now = Date.now()
    const H = 3600_000
    await mount({
      access: [access('Claude', { provider: 'anthropic', limits: { windowHours: 5 } })],
      blocks: [
        { source: 'claude-code', startTs: now - 30 * H, endTs: now - 25 * H, tokens: 1_000_000, costUsd: 20, requests: 90 },
        { source: 'claude-code', startTs: now - H, endTs: now + 4 * H, tokens: 500_000, costUsd: 10, requests: 40 }
      ],
      quotas: [slice()]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getAllByText(/Текущая сессия/)).toHaveLength(1)
    expect(within(panel).queryByText('≈50%')).not.toBeInTheDocument()
  })

  it('устаревший снимок подписан датой, свежий молчит', async () => {
    await mount({
      access: [access('Claude', { provider: 'anthropic' })],
      quotas: [slice({ checkedAt: Date.now() - 3 * 24 * 3600_000 })]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).getByText(/сверено/)).toBeInTheDocument()
  })

  it('текущий период не считается собственным максимумом', async () => {
    // Иначе доля выходит ровно 100 % каждый раз: период сравнивается сам с собой. На экране
    // владельца «Последние 7 дней» так и горели красными 100 % при спокойной неделе.
    const now = Date.now()
    const H = 3600_000
    await mount({
      access: [access('Claude', { provider: 'anthropic', limits: { windowHours: 5 } })],
      blocks: [{ source: 'claude-code', startTs: now - H, endTs: now + 4 * H, tokens: 900_000, costUsd: 10, requests: 40 }]
    })
    const panel = document.querySelector('aside') as HTMLElement
    expect(within(panel).queryByText('≈100%')).not.toBeInTheDocument()
    expect(within(panel).queryByText('100%')).not.toBeInTheDocument()
  })
})
