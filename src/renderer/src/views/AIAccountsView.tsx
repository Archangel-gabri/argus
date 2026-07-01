import { CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Page, PageHeader, StatTile, Card, SourceBadge, LimitNote } from '@/components/ui/Page'
import { money } from '@/lib/format'
import { MOCK_AI } from '@/data/ai'

export function AIAccountsView(): React.JSX.Element {
  const accounts = MOCK_AI
  const validCount = accounts.filter((a) => a.keyValid).length
  const totalCredit = accounts.filter((a) => a.source === 'live').reduce((s, a) => s + (a.creditRemaining ?? 0), 0)

  return (
    <Page>
      <PageHeader title="AI Accounts" subtitle="keys, plans & quota" />
      <LimitNote>
        Честно: <b className="text-slate-200">OpenRouter</b> отдаёт остаток и usage по API. Для
        Anthropic / OpenAI / Gemini доступна только <b className="text-slate-200">проверка валидности
        ключа</b> (тест-запрос); статус подписки (Pro/Plus) и токены — вручную.
      </LimitNote>

      <div className="grid grid-cols-3 gap-4">
        <StatTile label="Accounts" value={String(accounts.length)} />
        <StatTile label="Keys valid" value={`${validCount}/${accounts.length}`} />
        <StatTile label="Live credit" value={money(totalCredit)} hint="OpenRouter" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {accounts.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-sm font-bold text-accent">
                {a.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-white">{a.provider}</span>
                  <SourceBadge kind={a.source} />
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  Plan: <span className="text-slate-300">{a.plan}</span>
                </div>
              </div>
              <span className={cn('inline-flex items-center gap-1 text-xs', a.keyValid ? 'text-accent' : 'text-rose-400')}>
                {a.keyValid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                {a.keyValid ? 'key valid' : 'invalid'}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-bg/40 p-3">
                <div className="text-[11px] text-slate-500">Credit left</div>
                <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                  {a.creditRemaining != null ? money(a.creditRemaining) : '—'}
                </div>
              </div>
              <div className="rounded-lg bg-bg/40 p-3">
                <div className="text-[11px] text-slate-500">Usage (mo)</div>
                <div className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                  {a.usageMonth != null ? money(a.usageMonth) : '—'}
                </div>
              </div>
            </div>

            {a.note && <div className="mt-3 text-[11px] text-slate-500">ⓘ {a.note}</div>}
          </Card>
        ))}
      </div>
    </Page>
  )
}
