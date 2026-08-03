import { AlertTriangle, ArrowUpRight, CheckCircle2, KeyRound, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import {
  KIND_ONE,
  PAYMENT_LABEL,
  STATUS_LABEL,
  daysAgoDate,
  daysUntilExpiry,
  monthlyCost,
  subscriptionRoi,
  toUsd,
  totalsFor
} from '@/lib/ai-account'
import { LimitBar } from '@/components/ai/LimitBar'
import { useAi } from '@/store/ai'
import { useSubs } from '@/store/subs'
import type { AiAccess, AiCheck } from '@/types'

/** Строка «метка — значение». Двоеточий нет: их роль выполняет колонка. */
function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-3 py-[5px]">
      <span className="text-[11px] text-slate-600">{label}</span>
      <span className={cn('text-[12px] text-slate-300', tone)}>{children}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="border-t border-border/60 pt-3">
      <h3 className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-600">{title}</h3>
      {children}
    </section>
  )
}

function keyVerdict(check: AiCheck | undefined, hasKey: boolean): { text: string; tone: string; Icon: typeof KeyRound } {
  if (!hasKey) return { text: 'ключ не хранится', tone: 'text-slate-500', Icon: KeyRound }
  if (!check) return { text: 'не проверялся', tone: 'text-slate-500', Icon: KeyRound }
  if (check.status === 'valid') return { text: 'принимается', tone: 'text-emerald-400', Icon: CheckCircle2 }
  if (check.status === 'quota') return { text: 'лимит исчерпан, ключ живой', tone: 'text-amber-400', Icon: AlertTriangle }
  if (check.status === 'invalid') return { text: 'не принимается', tone: 'text-rose-400', Icon: XCircle }
  // «Не смогли спросить» — это не «ключ плохой»: по такому выводу рабочий ключ идёт на перевыпуск.
  return { text: check.detail ?? 'результат неизвестен', tone: 'text-slate-500', Icon: AlertTriangle }
}

/** Давность в словах: важно «когда примерно», а не точная отметка времени. */
function ago(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин. назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч. назад`
  return `${Math.floor(h / 24)} дн. назад`
}

export function AccessSummary({ access }: { access: AiAccess }): React.JSX.Element {
  const subs = useSubs((s) => s.subs)
  const usage = useAi((s) => s.usage)
  const blocks = useAi((s) => s.blocks)
  const all = useAi((s) => s.access)
  const check = useAi((s) => s.checks[access.id])
  const checking = useAi((s) => s.checking[access.id])
  const lastOk = useAi((s) => s.lastOk[access.id])
  const runCheck = useAi((s) => s.check)

  const sub = subs.find((s) => s.id === access.subscriptionId)
  const monthly = monthlyCost(sub)
  const source = access.usedBy.some((u) => u.toLowerCase().includes('claude code'))
    ? 'claude-code'
    : access.usedBy.some((u) => u.toLowerCase().includes('codex'))
      ? 'codex'
      : access.provider === 'anthropic'
        ? 'claude-code'
        : access.provider === 'openai'
          ? 'codex'
          : null
  const spent = source ? totalsFor(usage, { since: daysAgoDate(29), source }).costUsd : 0
  // Расход считается по долларовым ценам провайдеров, поэтому и цену подписки берём в долларах.
  const monthlyUsd = sub && monthly != null ? toUsd(monthly, sub.currency) : null
  const roi = sub ? subscriptionRoi(spent, monthlyUsd) : null
  const expiresIn = daysUntilExpiry(access.keyExpiresAt)
  const fallback = access.fallbackId ? all.find((a) => a.id === access.fallbackId) : undefined
  const verdict = keyVerdict(check, access.hasKey)
  const limits = access.limits

  return (
    <div className="space-y-3.5 px-5 py-4">
      {access.thirdParty && (
        <p className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-snug text-amber-300/90">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          Запросы идут через посредника. Всё отправленное, включая содержимое прочитанных файлов, проходит
          через третью сторону.
        </p>
      )}

      {source && <LimitBar access={access} blocks={blocks} source={source} />}

      <div>
        <Fact label="Тип">{KIND_ONE[access.kind]}</Fact>
        {access.account && <Fact label="Аккаунт">{access.account}</Fact>}
        {access.plan && <Fact label="Тариф">{access.plan}</Fact>}
        <Fact label="Состояние">{STATUS_LABEL[access.status]}</Fact>
        <Fact label="Оплата">{PAYMENT_LABEL[access.payment]}</Fact>
        {access.baseUrl && (
          <Fact label="Адрес">
            <code className="break-all text-[11px] text-slate-400">{access.baseUrl}</code>
          </Fact>
        )}
        {access.usedBy.length > 0 && <Fact label="Используют">{access.usedBy.join(', ')}</Fact>}
        {fallback && (
          <Fact label="Если умрёт">
            <span className="inline-flex items-center gap-1 text-slate-300">
              <ArrowUpRight className="h-3 w-3 text-slate-600" />
              {fallback.label}
            </span>
          </Fact>
        )}
      </div>

      {access.accounts.length > 0 && (
        <Section title={`Аккаунты · ${access.accounts.length}`}>
          <ul className="space-y-1 py-0.5">
            {access.accounts.map((a) => (
              <li key={a.email} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[12px] text-slate-300">
                  {a.email}
                  {a.primary && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-accent">основной</span>}
                </span>
                <span className="shrink-0 text-[11px] text-slate-500">{a.plan || 'тариф неизвестен'}</span>
              </li>
            ))}
          </ul>
          {access.accounts.some((a) => a.note) && (
            <ul className="mt-1.5 space-y-0.5 border-t border-border/40 pt-1.5">
              {access.accounts
                .filter((a) => a.note)
                .map((a) => (
                  <li key={a.email} className="text-[11px] leading-snug text-slate-600">
                    <span className="text-slate-500">{a.email}</span> — {a.note}
                  </li>
                ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Деньги">
        {sub ? (
          <>
            <Fact label="Подписка">
              {sub.name} · {money(sub.amount, sub.currency)}/{sub.period === 'yr' ? 'год' : 'мес'}
            </Fact>
            <Fact label="Продление">
              {sub.nextRenewal ?? 'дата не задана'}
              {sub.manualRenewal && <span className="ml-1.5 text-amber-400/80">руками</span>}
            </Fact>
            {spent > 0 && (
              <>
                <Fact label="Сожжено">
                  <span className="tabular-nums">{money(Math.round(spent))}</span>
                  <span className="ml-1.5 text-[11px] text-slate-600">за 30 дней, по ценам API</span>
                </Fact>
                {roi != null && (
                  <Fact label="Окупаемость" tone="text-emerald-400 font-medium">
                    ×{roi.toFixed(roi >= 10 ? 0 : 1)}
                    <span className="ml-1.5 font-normal text-[11px] text-slate-600">
                      против {money(Math.round(monthly ?? 0), sub.currency)} в месяц
                      {sub.currency !== 'USD' && monthlyUsd != null && (
                        <span className="text-slate-700"> (≈{money(Math.round(monthlyUsd))})</span>
                      )}
                    </span>
                  </Fact>
                )}
              </>
            )}
          </>
        ) : access.payment === 'free' ? (
          <p className="text-[12px] text-slate-500">Бесплатный доступ — платить не за что.</p>
        ) : (
          <p className="text-[12px] text-slate-500">
            Подписка не привязана. Свяжи с записью в разделе «Подписки», чтобы деньги считались один раз.
          </p>
        )}
      </Section>

      {(access.hasKey || access.keyRef || (access.kind !== 'subscription' && access.kind !== 'local')) && (
      <Section title="Ключ">
        <div className="flex items-center justify-between gap-3 py-1">
          <span className={cn('inline-flex items-center gap-1.5 text-[12px]', verdict.tone)}>
            <verdict.Icon className="h-3.5 w-3.5" />
            {verdict.text}
          </span>
          {access.hasKey && (
            <button
              onClick={() => void runCheck(access.id)}
              disabled={checking}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium text-slate-400 ring-1 ring-border transition-colors hover:bg-card-hover hover:text-slate-200 disabled:opacity-50"
            >
              {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Проверить
            </button>
          )}
        </div>
        {lastOk != null && <Fact label="Отвечал">{ago(lastOk)}</Fact>}
        {check?.usage != null && (
          <Fact label="Потрачено">
            <span className="tabular-nums">{money(check.usage)}</span>
          </Fact>
        )}
        {access.keyRef && (
          <Fact label="Хранится">
            <code className="break-all text-[11px] text-slate-400">{access.keyRef}</code>
          </Fact>
        )}
        {expiresIn !== null && (
          <Fact label="Истекает" tone={expiresIn <= 14 ? 'text-amber-400' : undefined}>
            {expiresIn < 0 ? `истёк ${-expiresIn} дн. назад` : `через ${expiresIn} дн.`}
            <span className="ml-1.5 text-[11px] text-slate-600">{access.keyExpiresAt}</span>
          </Fact>
        )}
      </Section>
      )}

      {(limits.rpm != null || limits.rpd != null || limits.tpmo != null || limits.windowHours != null) && (
        <Section title="Лимиты">
          {limits.rpm != null && <Fact label="В минуту">{limits.rpm} запросов</Fact>}
          {limits.rpd != null && <Fact label="В сутки">{limits.rpd} запросов</Fact>}
          {limits.tpmo != null && <Fact label="В месяц">{limits.tpmo.toLocaleString('ru-RU')} токенов</Fact>}
          {limits.windowHours != null && (
            <Fact label="Окно">
              {limits.windowHours} ч
              <span className="ml-1.5 text-[11px] text-slate-600">
                {limits.windowTokens != null
                  ? `потолок ${(limits.windowTokens / 1000).toFixed(0)}k — твоя оценка`
                  : 'потолок провайдер не публикует'}
              </span>
            </Fact>
          )}
        </Section>
      )}

      {access.notes && (
        <Section title="Заметка">
          <p className="whitespace-pre-line text-[12px] leading-relaxed text-slate-400">{access.notes}</p>
        </Section>
      )}
    </div>
  )
}
