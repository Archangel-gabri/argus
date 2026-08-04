import { AlertTriangle, ArrowUpRight, ExternalLink, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { ProviderMark } from '@/components/ai/ProviderMark'
import { LimitCards } from '@/components/ai/LimitCards'
import { AccountCards } from '@/components/ai/AccountCards'
import { UsageSection } from '@/components/ai/UsageSection'
import { ModelsSection } from '@/components/ai/ModelsSection'
import {
  KIND_ONE,
  PAYMENT_LABEL,
  STATUS_LABEL,
  daysAgoDate,
  daysUntilExpiry,
  monthlyCost,
  subscriptionRoi,
  sourceFor,
  toUsd,
  totalsFor
} from '@/lib/ai-account'
import { useAi } from '@/store/ai'
import { useSubs } from '@/store/subs'
import type { AiAccess } from '@/types'

type Block = 'limits' | 'accounts' | 'usage' | 'models'

/**
 * Порядок блоков под тип доступа.
 *
 * За разными записями приходят с разными вопросами: у подписки — «сколько осталось в окне и
 * окупается ли», у ключа — «жив ли он и что им можно», у локальной модели — «что установлено».
 * Держать один порядок на всех значит показывать половине записей пустое место в самом верху.
 */
export function blocksFor(access: AiAccess): Block[] {
  switch (access.kind) {
    case 'subscription':
    case 'cli-agent':
      return ['limits', 'usage', 'accounts', 'models']
    case 'router':
    case 'api':
      return ['limits', 'models', 'usage', 'accounts']
    case 'free-tier':
      return ['limits', 'models', 'accounts', 'usage']
    case 'local':
      return ['models', 'usage', 'limits', 'accounts']
    default:
      return ['limits', 'accounts', 'usage', 'models']
  }
}

/** Короткий факт в шапке: подпись сверху, значение снизу. */
function HeadFact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.12em] text-slate-600">{label}</div>
      <div className="mt-0.5 truncate text-[12px] text-slate-300">{children}</div>
    </div>
  )
}

/**
 * Страница доступа.
 *
 * Вкладок здесь нет намеренно: они прятали половину сведений о доступе за лишним кликом, а места
 * на широком экране хватает, чтобы показать всё сразу — сначала лимиты и аккаунты (за ними
 * приходят чаще всего), ниже расход и модели.
 */
export function AccessDetail({
  access,
  onEdit,
  onDelete
}: {
  access: AiAccess
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const subs = useSubs((s) => s.subs)
  const usage = useAi((s) => s.usage)
  const blocks = useAi((s) => s.blocks)
  const all = useAi((s) => s.access)
  const check = useAi((s) => s.checks[access.id])

  const sub = subs.find((s) => s.id === access.subscriptionId)
  const monthly = monthlyCost(sub)
  const monthlyUsd = sub && monthly != null ? toUsd(monthly, sub.currency) : null
  const source = sourceFor(access, all)
  const spent = source ? totalsFor(usage, { since: daysAgoDate(29), source }).costUsd : 0
  const roi = sub ? subscriptionRoi(spent, monthlyUsd) : null
  const expiresIn = daysUntilExpiry(access.keyExpiresAt)
  const fallback = access.fallbackId ? all.find((a) => a.id === access.fallbackId) : undefined

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/95 px-6 py-4 backdrop-blur">
        <div className="flex items-start gap-3.5">
          <ProviderMark provider={access.provider} label={access.label} size={34} tinted className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[17px] font-semibold text-white">{access.label}</h2>
              {access.status !== 'active' && (
                <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                  {STATUS_LABEL[access.status]}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-slate-500">
              {access.provider} · {KIND_ONE[access.kind]}
              {access.account && <span className="text-slate-600"> · {access.account}</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={onEdit}
              title="Изменить"
              className="rounded p-1.5 text-slate-600 transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              onClick={onDelete}
              title="Удалить"
              className="rounded p-1.5 text-slate-600 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {/* Деньги одной строкой: цена, способ оплаты, продление и окупаемость — это один
              ответ на вопрос «во что обходится», а не четыре равновеликих факта. */}
          <div className="col-span-2 min-w-0 sm:col-span-2">
            <div className="text-[10px] uppercase tracking-[0.12em] text-slate-600">Оплата</div>
            <div className="mt-0.5 truncate text-[12px] text-slate-300">
              {sub ? (
                <>
                  {money(sub.amount, sub.currency)}
                  <span className="text-slate-600">/{sub.period === 'yr' ? 'год' : 'мес'}</span>
                  <span className="text-slate-600"> · {PAYMENT_LABEL[access.payment]}</span>
                  {sub.nextRenewal && <span className="text-slate-600"> · продление {sub.nextRenewal}</span>}
                  {roi != null && (
                    <span className="ml-1 text-emerald-400" title="Оценка: цены каталожные, курс валют справочный">
                      ≈×{roi.toFixed(roi >= 10 ? 0 : 1)} по ценам API
                    </span>
                  )}
                </>
              ) : access.payment === 'free' ? (
                'бесплатно'
              ) : (
                <span className="text-slate-600">подписка не привязана · {PAYMENT_LABEL[access.payment]}</span>
              )}
            </div>
          </div>
          {access.usedBy.length > 0 && <HeadFact label="Используют">{access.usedBy.join(', ')}</HeadFact>}
          {fallback && (
            <HeadFact label="Если умрёт">
              <span className="inline-flex items-center gap-1">
                <ArrowUpRight className="h-3 w-3 text-slate-600" />
                {fallback.label}
              </span>
            </HeadFact>
          )}
          {access.baseUrl && (
            <HeadFact label="Адрес">
              <code className="text-[11px] text-slate-400">{access.baseUrl}</code>
            </HeadFact>
          )}
          {expiresIn !== null && (
            <HeadFact label="Ключ истекает">
              <span className={cn(expiresIn <= 14 && 'text-amber-400')}>
                {expiresIn < 0 ? `истёк ${-expiresIn} дн. назад` : `через ${expiresIn} дн.`}
              </span>
            </HeadFact>
          )}
        </div>
      </header>

      <div className="space-y-6 px-6 py-5">
        {access.thirdParty && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12px] leading-snug text-amber-300/90">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
            Запросы идут через посредника{access.baseUrl ? ` (${access.baseUrl})` : ''}. Всё отправленное,
            включая содержимое прочитанных файлов, проходит через третью сторону.
          </p>
        )}

        {/* Порядок блоков зависит от того, что это за доступ. У подписки сначала лимиты и
            расход, у ключа — состояние и модели, у локальной модели — где она стоит и что
            умеет. Один порядок на все шесть типов оставлял большинству записей пустой верх. */}
        {blocksFor(access).map((block) => {
          if (block === 'limits')
            return (
              <LimitCards
                key={block}
                access={access}
                blocks={blocks}
                days={usage}
                source={source}
                check={check}
              />
            )
          if (block === 'accounts') return <AccountCards key={block} access={access} />
          // Расход показывается, только когда есть чей считать: заглушка «логов нет» на
          // полэкрана — это блок, объясняющий собственную бесполезность.
          if (block === 'usage') return source ? <UsageSection key={block} access={access} source={source} /> : null
          return <ModelsSection key={block} access={access} />
        })}

        {(access.keyRef || access.notes) && (
          <section className="space-y-2 border-t border-border/60 pt-4 text-[11px] text-slate-600">
            {access.keyRef && (
              <p>
                Ключ хранится: <code className="text-slate-500">{access.keyRef}</code>
              </p>
            )}
            {access.notes && <p className="whitespace-pre-line leading-relaxed text-slate-500">{access.notes}</p>}
            {access.baseUrl && (
              <a
                href={access.baseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-400"
              >
                <ExternalLink className="h-3 w-3" /> открыть адрес доступа
              </a>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
