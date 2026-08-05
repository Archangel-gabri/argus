import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { daysAgoDate, totalsFor } from '@/lib/ai-account'
import { DEFAULT_WINDOW_HOURS, formatResetIn, mergeBlocks, windowState } from '../../../../shared/ai-blocks'
import { totalTokens } from '../../../../shared/ai-pricing'
import { CREDIT_WARNING_USD } from '../../../../shared/ai-thresholds'
import type { AiAccess, AiCheck, AiQuotaSlice, AiUsageBlock, AiUsageDay } from '@/types'

function tokens(n: number): string {
  // По-русски: «4.9M» и «20k» в остальном русском интерфейсе читаются как чужие.
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} млн`
  if (n >= 1000) return `${Math.round(n / 1000)} тыс.`
  return String(n)
}

/** Сутки. Снимок квоты старше — уже не «сейчас», и об этом надо сказать. */
const STALE_MS = 24 * 60 * 60 * 1000

function amount(value: number, unit: string): string {
  if (unit === '$') return money(value)
  if (unit === 'токенов') return tokens(value)
  return value.toLocaleString('ru-RU')
}

/**
 * Квота, названная самим провайдером.
 *
 * Это единственная цифра раздела, которая знает про все устройства владельца: расход по локальным
 * логам видит только эту машину, а тут отвечает сам аккаунт. Поэтому доля — сплошная и без «≈»:
 * она измерена, а не оценена.
 *
 * У Anthropic знаменателя нет вовсе — он публикует проценты и не публикует потолок. Подставлять
 * туда токены из своих логов нельзя: получится дробь, у которой числитель с одной машины, а
 * знаменатель со всех.
 */
function ProviderCard({ slice, now }: { slice: AiQuotaSlice; now: number }): React.JSX.Element {
  const ratio = slice.ratio ?? (slice.limit && slice.limit > 0 && slice.used != null ? slice.used / slice.limit : null)
  const over = ratio != null && ratio >= 1
  const nearing = ratio != null && ratio >= 0.8
  const stale = now - slice.checkedAt > STALE_MS

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-slate-200">{slice.label}</span>
        <span className={cn('text-[15px] font-semibold tabular-nums', over ? 'text-rose-400' : 'text-white')}>
          {ratio != null ? `${Math.round(ratio * 100)}%` : slice.used != null ? amount(slice.used, slice.unit) : '—'}
        </span>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700',
            over ? 'bg-rose-500' : nearing ? 'bg-amber-400' : 'bg-accent'
          )}
          style={{ width: `${Math.max(2, Math.min(1, ratio ?? 0) * 100)}%` }}
        />
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px] text-slate-500">
        <span className="truncate">
          {slice.resetsAt
            ? slice.resetsAt - now > 0 && slice.resetsAt - now < 7 * 24 * 60 * 60 * 1000
              ? `сброс ${formatResetIn(slice.resetsAt - now)}`
              : `до ${new Date(slice.resetsAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`
            : (slice.plan ?? '')}
        </span>
        <span className="shrink-0 tabular-nums">
          {/* Нулевой потолок проверяется ПЕРВЫМ: у бесплатного тарифа Cursor и расход, и лимит
              равны нулю, и пара «0 из 0» читается как исправная шкала, хотя означает, что
              включённого расхода нет вовсе. */}
          {slice.limit === 0
            ? 'включённого расхода нет'
            : slice.used != null && slice.limit != null
              ? `${amount(slice.used, slice.unit)} из ${amount(slice.limit, slice.unit)}`
              : ''}
        </span>
      </div>

      {/* Свежий снимок молчит: нормальная работа не отчитывается. Говорит только устаревший. */}
      {stale && (
        <div className="mt-1 text-[11px] text-amber-400/70">
          сверено {new Date(slice.checkedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}
        </div>
      )}
    </div>
  )
}

/**
 * Одна плашка лимита, посчитанного по локальным логам.
 *
 * Отличается от провайдерской намеренно: доля здесь считается от наблюдаемого максимума, то есть
 * это оценка снизу по истории ОДНОЙ машины. Знак «≈» и приглушённая полоса — не украшение, а
 * единственное, что отличает её от измерения.
 */
function LimitCard({
  title,
  caption,
  spent,
  limit,
  elapsed,
  elapsedNote,
  peak
}: {
  title: string
  caption: string
  spent: number
  limit: number | null
  /** Доля прошедшего времени периода — полоса, когда мерить не от чего. */
  elapsed: number
  /** Чем подписать полосу времени: «прошло 16 ч из 24». */
  elapsedNote?: string
  /** Самый нагруженный ЗАВЕРШЁННЫЙ период того же рода. */
  peak?: number
}): React.JSX.Element {
  // Потолок владельца — это факт, наблюдаемый максимум — оценка. Считаем от того, что есть:
  // ждать, пока человек нажмёт кнопку, чтобы увидеть проценты, незачем — данные для оценки
  // лежат в его же истории. Но оценку положено называть оценкой.
  const own = limit && limit > 0 ? limit : null
  const observed = !own && peak && peak > 0 ? peak : null
  const scale = own ?? observed
  const used = scale ? spent / scale : null

  const byLimit = used != null
  const fill = Math.min(1, byLimit ? used : elapsed)
  const over = byLimit && used > 1
  const nearing = byLimit && used >= 0.8

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-200">{title}</span>
        <span className={cn('text-[15px] font-semibold tabular-nums', over ? 'text-rose-400' : 'text-white')}>
          {byLimit ? `${observed ? '≈' : ''}${Math.round(used * 100)}%` : tokens(spent)}
        </span>
      </div>

      {/* Сплошная полоса — доля известного потолка. Приглушённая — доля наблюдаемого максимума,
          то есть оценка. Штриховая — вообще не про расход, а про прошедшее время периода. */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700',
            over ? 'bg-rose-500' : nearing ? 'bg-amber-400' : own ? 'bg-accent' : observed ? 'bg-accent/50' : 'bg-slate-700'
          )}
          style={{
            width: `${Math.max(2, fill * 100)}%`,
            ...(byLimit
              ? {}
              : {
                  backgroundImage:
                    'repeating-linear-gradient(135deg, rgba(255,255,255,0.10) 0 3px, transparent 3px 6px)'
                })
          }}
        />
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px] text-slate-500">
        <span>{caption}</span>
        <span className="tabular-nums">
          {own
            ? `${tokens(spent)} из ${tokens(own)}`
            : observed
              ? `${tokens(spent)} из ${tokens(observed)} — наблюдаемый максимум`
              : (elapsedNote ?? '')}
        </span>
      </div>
    </div>
  )
}

/** Остаток денег, когда провайдер отдаёт его проверкой ключа, а не квотой. */
function BalanceCard({ check }: { check: AiCheck }): React.JSX.Element {
  const remaining = check.remaining ?? 0
  const spent = check.usage ?? 0
  const total = remaining + spent
  const left = total > 0 ? remaining / total : 0
  // Порог общий со сторожем: пока он стоял здесь числом, жёлтая полоса и уведомление могли
  // разъехаться, и обе цифры выглядели бы осмысленно.
  const low = remaining <= CREDIT_WARNING_USD

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-200">Баланс</span>
        <span className={cn('text-[15px] font-semibold tabular-nums', low ? 'text-amber-400' : 'text-white')}>
          {money(remaining)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn('h-full rounded-full', low ? 'bg-amber-400' : 'bg-accent')}
          style={{ width: `${Math.max(2, left * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2 text-[11px] text-slate-500">
        <span>{low ? 'почти исчерпан' : 'осталось'}</span>
        <span className="tabular-nums">потрачено {money(spent)}</span>
      </div>
    </div>
  )
}

/** Какие периоды провайдер уже закрыл сам — по ним своя оценка больше не нужна. */
export function coveredScopes(slices: AiQuotaSlice[]): { session: boolean; week: boolean } {
  return {
    session: slices.some((s) => s.scope === 'session'),
    week: slices.some((s) => s.scope === 'week' || s.scope === 'week-model')
  }
}

/**
 * Лимиты доступа.
 *
 * Порядок один и тот же везде: сначала то, что сказал провайдер, потом то, что мы посчитали сами.
 * Если провайдер уже назвал долю за период, своя оценка за тот же период не показывается вовсе —
 * два разных ответа на один вопрос рядом читаются как ошибка, и правильно читаются: один из них
 * неверный.
 */
export function LimitCards({
  access,
  blocks,
  days,
  source,
  check,
  quotas = [],
  now = Date.now()
}: {
  access: AiAccess
  blocks: AiUsageBlock[]
  days: AiUsageDay[]
  /** Источник логов расхода или null, если своих логов у доступа нет. */
  source: string | null
  check?: AiCheck
  /** Срезы квоты, полученные от провайдера. */
  quotas?: AiQuotaSlice[]
  now?: number
}): React.JSX.Element | null {
  const covered = coveredScopes(quotas)
  // Осколки склеиваются перед счётом: в базе одно пятичасовое окно может лежать несколькими
  // перекрывающимися блоками (разные разговоры, разные проходы сборщика). Без склейки пик
  // считался по осколку и выходил заниженным — а именно от него берётся доля, когда своего
  // потолка нет.
  const mine = source ? mergeBlocks(blocks.filter((b) => b.source === source)) : []
  const state = source ? windowState(mine, access.limits.windowTokens, now) : null

  // Пик считается по ЗАВЕРШЁННЫМ периодам. Текущий период — сам себе максимум, и если включить
  // его в расчёт, доля всегда выйдет ровно 100 %: полоса упиралась в край каждый день.
  const sessionPeak = mine
    .filter((b) => b.startTs !== state?.block.startTs)
    .reduce((max, b) => Math.max(max, b.tokens), 0)

  const today = source ? totalsFor(days, { since: daysAgoDate(0), source }) : null
  const week = source ? totalsFor(days, { since: daysAgoDate(6), source }) : null
  const todayTokens = today ? totalTokens(today.usage) : 0
  const weekTokens = week ? totalTokens(week.usage) : 0

  // Пик недели — по скользящим неделям истории: разовый всплеск важнее среднего, потому что
  // лимит бьёт именно по нему. Отсчёт с прошлой недели — текущая ещё не дожита.
  const weekPeak = (() => {
    if (!source) return 0
    let max = 0
    for (let offset = 1; offset <= 8; offset++) {
      const since = daysAgoDate(6 + offset * 7)
      const until = daysAgoDate(offset * 7)
      const sum = days
        .filter((d) => d.source === source && d.date >= since && d.date <= until)
        .reduce((n, d) => n + d.input + d.output + d.cacheWrite + d.cacheWrite1h + d.cacheRead, 0)
      max = Math.max(max, sum)
    }
    return max
  })()

  const dayPeak = (() => {
    if (!source) return 0
    const todayDate = daysAgoDate(0)
    const byDate = new Map<string, number>()
    for (const d of days) {
      if (d.source !== source || d.date >= todayDate) continue
      byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.input + d.output + d.cacheWrite + d.cacheWrite1h + d.cacheRead)
    }
    return Math.max(0, ...byDate.values())
  })()

  const hasBalance = typeof check?.remaining === 'number' && quotas.length === 0
  // Объявленные лимиты тарифа — тоже повод показать блок: у бесплатного доступа это всё, что
  // о нём известно, и прятать их значит оставлять такие записи вовсе без лимитов.
  const declared = access.limits.rpd != null || access.limits.rpm != null || access.limits.tpmo != null
  if (!source && !hasBalance && quotas.length === 0 && !declared) return null

  const hours = access.limits.windowHours ?? DEFAULT_WINDOW_HOURS
  const nowDate = new Date(now)
  const dayElapsedHours = nowDate.getHours()
  const dayElapsed = (dayElapsedHours * 60 + nowDate.getMinutes()) / (24 * 60)

  return (
    <section>
      <h3 className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Лимиты</span>
        {access.plan && <span className="truncate text-[11px] text-slate-500">{access.plan}</span>}
      </h3>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {quotas.map((q) => (
          <ProviderCard key={`${q.scope}-${q.label}`} slice={q} now={now} />
        ))}
        {hasBalance && check && <BalanceCard check={check} />}

        {source && (
          <>
            {!covered.session &&
              (state ? (
                <LimitCard
                  title="Текущая сессия"
                  caption={`сбросится ${formatResetIn(state.resetsInMs)}`}
                  spent={state.block.tokens}
                  limit={access.limits.windowTokens ?? null}
                  elapsed={state.elapsed}
                  elapsedNote={`окно ${hours} ч`}
                  peak={sessionPeak}
                />
              ) : (
                <div className="rounded-lg border border-border bg-card/50 p-3.5">
                  <div className="text-[12px] font-medium text-slate-200">Текущая сессия</div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    не начата — окно {hours} ч открывается с первого запроса
                  </p>
                </div>
              ))}

            <LimitCard
              title="Сегодня"
              caption="с начала суток"
              spent={todayTokens}
              limit={access.limits.tpd ?? null}
              elapsed={dayElapsed}
              elapsedNote={`прошло ${dayElapsedHours} ч из 24`}
              peak={dayPeak}
            />

            {!covered.week && (
              <LimitCard
                title="Последние 7 дней"
                caption="скользящее окно"
                spent={weekTokens}
                limit={access.limits.weekTokens ?? null}
                // Окно скользящее, поэтому «прошедшего времени» у него нет: показываем полную
                // полосу. Раньше здесь стоял день календарной недели — расход считался за одно,
                // а полоса рисовалась про другое.
                elapsed={1}
                peak={weekPeak}
              />
            )}
          </>
        )}
      </div>

      {(access.limits.rpm != null || access.limits.rpd != null || access.limits.rpmo != null || access.limits.tpmo != null) && (
        <p className="mt-2 text-[11px] text-slate-500">
          {/* Это условия тарифа, а не измерение: провайдер их объявил, но сколько израсходовано,
              по ним не узнать. Подписываем отдельно, чтобы не путались с посчитанным расходом. */}
          По условиям тарифа:{' '}
          {[
            access.limits.rpm != null ? `${access.limits.rpm} запросов в минуту` : null,
            access.limits.rpd != null ? `${access.limits.rpd.toLocaleString('ru-RU')} запросов в сутки` : null,
            access.limits.rpmo != null ? `${access.limits.rpmo.toLocaleString('ru-RU')} запросов в месяц` : null,
            access.limits.tpmo != null ? `${(access.limits.tpmo / 1_000_000).toFixed(0)}M токенов в месяц` : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </section>
  )
}
