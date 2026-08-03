import { CheckCircle2, KeyRound, Loader2, RefreshCw, XCircle, AlertTriangle } from 'lucide-react'
import { money } from '@/lib/format'
import { daysUntilExpiry } from '@/lib/ai-account'
import { useAi } from '@/store/ai'
import type { AiAccess, AiCheck } from '@/types'

function verdictText(check: AiCheck | undefined, hasKey: boolean): { text: string; tone: string; icon: typeof KeyRound } {
  if (!hasKey) return { text: 'Ключ не сохранён', tone: 'text-slate-500', icon: KeyRound }
  if (!check) return { text: 'Ещё не проверялся', tone: 'text-slate-500', icon: KeyRound }
  if (check.status === 'valid') return { text: 'Ключ рабочий', tone: 'text-emerald-400', icon: CheckCircle2 }
  if (check.status === 'quota') return { text: 'Лимит исчерпан — ключ живой', tone: 'text-amber-400', icon: AlertTriangle }
  if (check.status === 'invalid') return { text: 'Ключ не принят', tone: 'text-rose-400', icon: XCircle }
  if (check.status === 'nokey') return { text: 'Ключ не сохранён', tone: 'text-slate-500', icon: KeyRound }
  // Ошибка сети и «провайдер не проверяется» — это НЕ «ключ плохой». Разница принципиальна:
  // по первому выводу ключ выбрасывают, хотя с ним всё в порядке.
  return { text: check.detail ?? 'Результат неизвестен', tone: 'text-slate-400', icon: AlertTriangle }
}

/** «Отвечал 3 дн. назад» вместо голой отметки времени: важна давность, а не точная дата. */
function agoLabel(ts: number, now = Date.now()): string {
  const minutes = Math.floor((now - ts) / 60_000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин. назад`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч. назад`
  return `${Math.floor(hours / 24)} дн. назад`
}

export function AccessKey({ access }: { access: AiAccess }): React.JSX.Element {
  const check = useAi((s) => s.checks[access.id])
  const checking = useAi((s) => s.checking[access.id])
  const lastOk = useAi((s) => s.lastOk[access.id])
  const runCheck = useAi((s) => s.check)

  const v = verdictText(check, access.hasKey)
  const Icon = v.icon
  const expiresIn = daysUntilExpiry(access.keyExpiresAt)

  return (
    <div className="space-y-4 p-5">
      <div className="rounded-lg border border-border bg-bg/40 p-4">
        <div className="flex items-center justify-between">
          <span className={`inline-flex items-center gap-2 text-sm font-medium ${v.tone}`}>
            <Icon className="h-4 w-4" /> {v.text}
          </span>
          <button
            onClick={() => void runCheck(access.id)}
            disabled={!access.hasKey || checking}
            className="flex items-center gap-1.5 rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Проверить
          </button>
        </div>
        {check?.detail && v.text !== check.detail && <div className="mt-2 text-[11px] text-slate-600">{check.detail}</div>}
        {lastOk != null && (
          <div className="mt-2 text-[11px] text-slate-600">Последний раз точно работал: {agoLabel(lastOk)}</div>
        )}
      </div>

      {(check?.remaining != null || check?.usage != null) && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-bg/40 p-3">
            <div className="text-[11px] text-slate-500">Остаток</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-white">
              {check.remaining != null ? money(check.remaining) : '—'}
            </div>
          </div>
          <div className="rounded-lg bg-bg/40 p-3">
            <div className="text-[11px] text-slate-500">Потрачено</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-white">
              {check.usage != null ? money(check.usage) : '—'}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Где лежит значение</div>
        {access.keyRef ? (
          <code className="block break-all text-xs text-slate-300">{access.keyRef}</code>
        ) : (
          <div className="text-xs text-slate-600">
            Указатель не задан. Если Argus переустановят, ключ придётся выпускать заново.
          </div>
        )}
        {access.hasKey && (
          <div className="mt-2 text-[11px] text-slate-600">
            Само значение хранится в зашифрованном вольте и наружу — в интерфейс, логи и буфер обмена —
            не выдаётся.
          </div>
        )}
      </div>

      {expiresIn !== null && (
        <div
          className={`rounded-lg border p-3 text-xs ${
            expiresIn <= 14 ? 'border-amber-500/20 bg-amber-500/5 text-amber-300' : 'border-border text-slate-500'
          }`}
        >
          {expiresIn < 0
            ? `Истёк ${-expiresIn} дн. назад (${access.keyExpiresAt}) — выпусти новый.`
            : `Действует ещё ${expiresIn} дн., до ${access.keyExpiresAt}.`}
        </div>
      )}
    </div>
  )
}
