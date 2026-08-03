import { AlertTriangle, ArrowRight, Wallet } from 'lucide-react'
import { money } from '@/lib/format'
import {
  KIND_LABEL,
  PAYMENT_LABEL,
  STATUS_LABEL,
  daysUntilExpiry,
  monthlyCost,
  subscriptionRoi,
  totalsFor,
  daysAgoDate
} from '@/lib/ai-account'
import { useAi } from '@/store/ai'
import { useSubs } from '@/store/subs'
import type { AiAccess } from '@/types'

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right text-xs text-slate-200">
        {value}
        {hint && <span className="mt-0.5 block text-[11px] text-slate-600">{hint}</span>}
      </span>
    </div>
  )
}

export function AccessOverview({ access }: { access: AiAccess }): React.JSX.Element {
  const subs = useSubs((s) => s.subs)
  const usage = useAi((s) => s.usage)
  const all = useAi((s) => s.access)

  const sub = subs.find((s) => s.id === access.subscriptionId)
  const monthly = monthlyCost(sub)
  const since = daysAgoDate(30)
  // Расход инструмента, а не «доступа»: логи знают, каким CLI сожжены токены, но не знают,
  // на какой аккаунт он смотрел. Для подписки Claude Code это одно и то же, и это честно.
  const source = access.provider === 'anthropic' ? 'claude-code' : access.provider === 'openai' ? 'codex' : null
  const spent = source ? totalsFor(usage, { since, source }) : null
  const roi = spent && sub ? subscriptionRoi(spent.costUsd, monthly) : null
  const expiresIn = daysUntilExpiry(access.keyExpiresAt)
  const fallback = access.fallbackId ? all.find((a) => a.id === access.fallbackId) : undefined

  return (
    <div className="space-y-5 p-5">
      {access.thirdParty && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Запросы идут через посредника{access.baseUrl ? ` (${access.baseUrl})` : ''}. Всё отправленное — включая
            содержимое прочитанных файлов — проходит через третью сторону.
          </span>
        </div>
      )}

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Доступ</div>
        <Row label="Тип" value={KIND_LABEL[access.kind]} />
        <Row label="Провайдер" value={access.provider} />
        <Row label="Аккаунт" value={access.account || '—'} />
        <Row label="План" value={access.plan || '—'} />
        <Row label="Состояние" value={STATUS_LABEL[access.status]} />
        <Row label="Оплата" value={PAYMENT_LABEL[access.payment]} />
        {access.baseUrl && <Row label="Адрес API" value={access.baseUrl} />}
        {access.usedBy.length > 0 && <Row label="Кем используется" value={access.usedBy.join(', ')} />}
        {fallback && (
          <Row
            label="Если умрёт"
            value={
              <span className="inline-flex items-center gap-1">
                <ArrowRight className="h-3 w-3 text-slate-500" /> {fallback.label}
              </span>
            }
          />
        )}
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Деньги</div>
        {sub ? (
          <>
            <Row
              label="Подписка"
              value={
                <span className="inline-flex items-center gap-1">
                  <Wallet className="h-3 w-3 text-accent" /> {sub.name}
                </span>
              }
              hint={`${money(sub.amount, sub.currency)} / ${sub.period === 'yr' ? 'год' : 'мес'}`}
            />
            <Row label="Следующее продление" value={sub.nextRenewal ?? '—'} hint={sub.manualRenewal ? 'продлевать руками' : undefined} />
            {spent && (
              <Row
                label="Сожжено за 30 дней"
                value={money(Math.round(spent.costUsd * 100) / 100)}
                hint="эквивалент по ценам API — по подписке это не списанные деньги"
              />
            )}
            {roi != null && (
              <Row
                label="Окупаемость"
                value={<span className="font-semibold text-emerald-400">×{roi.toFixed(1)}</span>}
                hint={`против ${money(Math.round((monthly ?? 0) * 100) / 100)} в месяц`}
              />
            )}
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-slate-500">
            {access.payment === 'free'
              ? 'Бесплатный доступ — платить не за что.'
              : 'Подписка не привязана. Свяжи с записью в разделе «Подписки», чтобы деньги считались один раз.'}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Лимиты</div>
        {Object.values(access.limits).some((v) => v != null) ? (
          <>
            {access.limits.rpm != null && <Row label="Запросов в минуту" value={access.limits.rpm} />}
            {access.limits.rpd != null && <Row label="Запросов в сутки" value={access.limits.rpd} />}
            {access.limits.tpmo != null && <Row label="Токенов в месяц" value={access.limits.tpmo.toLocaleString('ru-RU')} />}
            {access.limits.windowHours != null && (
              <Row
                label="Окно лимита"
                value={`${access.limits.windowHours} ч`}
                hint={
                  access.limits.windowTokens != null
                    ? `${(access.limits.windowTokens / 1000).toFixed(0)}k токенов — твоя оценка, провайдер её не публикует`
                    : 'потолок неизвестен: провайдер его не публикует'
                }
              />
            )}
          </>
        ) : (
          <div className="text-xs text-slate-600">Лимиты не заданы.</div>
        )}
      </div>

      {expiresIn !== null && (
        <div
          className={`rounded-lg border p-3 text-xs ${
            expiresIn <= 14 ? 'border-amber-500/20 bg-amber-500/5 text-amber-300' : 'border-border text-slate-500'
          }`}
        >
          {expiresIn < 0
            ? `Ключ истёк ${-expiresIn} дн. назад (${access.keyExpiresAt}).`
            : `Ключ действует ещё ${expiresIn} дн. (до ${access.keyExpiresAt}).`}
        </div>
      )}

      {access.notes && <div className="rounded-lg bg-bg/40 p-3 text-xs text-slate-400">{access.notes}</div>}
    </div>
  )
}
