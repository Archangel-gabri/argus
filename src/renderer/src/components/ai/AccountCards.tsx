import { useState } from 'react'
import { Check, Copy, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react'
import { cn } from '@/lib/cn'
import { familyAccounts } from '@/lib/ai-account'
import { useAi } from '@/store/ai'
import type { AiAccess, AiAccountEntry } from '@/types'

/** Куда идти логиниться, если у записи не задан свой адрес. */
const LOGIN_URL: Record<string, string> = {
  openai: 'https://chatgpt.com/auth/login',
  anthropic: 'https://claude.ai/login',
  gemini: 'https://aistudio.google.com/',
  google: 'https://aistudio.google.com/',
  deepseek: 'https://platform.deepseek.com/sign_in',
  openrouter: 'https://openrouter.ai/settings/credits',
  github: 'https://github.com/login',
  cursor: 'https://cursor.com/dashboard',
  mistral: 'https://console.mistral.ai/',
  groq: 'https://console.groq.com/',
  cerebras: 'https://cloud.cerebras.ai/',
  modelscope: 'https://www.modelscope.cn/my/myaccesstoken',
  nvidia: 'https://build.nvidia.com/',
  tavily: 'https://app.tavily.com/',
  exa: 'https://dashboard.exa.ai/',
  firecrawl: 'https://www.firecrawl.dev/app'
}

/** «3 мес назад» — давность важнее точной даты: она отвечает на вопрос «этим ещё пользуются?». */
function ago(ts: number, now = Date.now()): string {
  const days = Math.floor((now - ts) / 86_400_000)
  if (days <= 0) return 'сегодня'
  if (days === 1) return 'вчера'
  if (days < 30) return `${days} дн. назад`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} мес. назад`
  return `${Math.floor(months / 12)} г. назад`
}

/** Платный тариф выделяется: именно его ищут, открывая список из семи почт. */
function isPaid(plan?: string): boolean {
  return Boolean(plan) && !/free|бесплат|не провер|неизвест|нет\b/i.test(plan ?? '')
}

function AccountCard({
  access,
  account,
  ownerId,
  ownerLabel
}: {
  access: AiAccess
  account: AiAccountEntry
  ownerId: string
  ownerLabel: string
}): React.JSX.Element {
  const copyPassword = useAi((s) => s.copyAccountPassword)
  const checkKey = useAi((s) => s.checkAccountKey)
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)

  const url = account.loginUrl || LOGIN_URL[access.provider.toLowerCase()]
  const authorized = Boolean(account.hasPassword || account.hasKey)

  const onCopy = async (): Promise<void> => {
    if (!(await copyPassword(ownerId, account.email))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        account.primary
          ? 'border-accent/30 bg-accent/[0.04]'
          : account.verified
            ? 'border-border bg-card/40'
            : 'border-border/50 bg-card/20 opacity-70'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-slate-200" title={account.email}>
            {account.email}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-600">
            {account.primary && <span className="text-accent">основной</span>}
            {account.via && <span>вход через {account.via}</span>}
            {account.lastUsedAt && <span>вход {ago(account.lastUsedAt)}</span>}
            {!account.verified && <span className="text-slate-700">не подтверждён</span>}
            {ownerId !== access.id && <span>из «{ownerLabel}»</span>}
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
            isPaid(account.plan) ? 'bg-accent/15 text-accent' : 'bg-white/[0.04] text-slate-500'
          )}
        >
          {account.plan || 'тариф неизвестен'}
        </span>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 text-[11px]',
            authorized ? 'text-emerald-400/80' : 'text-slate-600'
          )}
        >
          {authorized ? <ShieldCheck className="h-3 w-3" /> : <ShieldOff className="h-3 w-3" />}
          {account.hasPassword && account.hasKey
            ? 'пароль и ключ'
            : account.hasPassword
              ? 'пароль сохранён'
              : account.hasKey
                ? 'ключ сохранён'
                : 'без доступа'}
        </span>

        <span className="flex items-center gap-0.5">
          {account.hasPassword && (
            <button
              onClick={() => void onCopy()}
              title="Скопировать пароль"
              className="rounded p-1 text-slate-600 transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          )}
          {account.hasKey && (
            <button
              onClick={() => {
                setChecking(true)
                void checkKey(ownerId, account.email).finally(() => setChecking(false))
              }}
              disabled={checking}
              title="Проверить ключ этого аккаунта"
              className="rounded p-1 text-slate-600 transition-colors hover:bg-white/5 hover:text-slate-200 disabled:opacity-50"
            >
              {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </button>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              title="Открыть страницу входа"
              className="rounded p-1 text-slate-600 transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </span>
      </div>

      {account.note && <p className="mt-2 text-[11px] leading-snug text-slate-600">{account.note}</p>}
    </div>
  )
}

/**
 * Все аккаунты провайдера карточками.
 *
 * Аккаунты берутся по СЕМЬЕ: подписка ChatGPT, Codex через роутер и ключ API — три записи об
 * одних и тех же почтах, и открыв любую, владелец должен видеть весь список целиком.
 *
 * Пароли подтягиваются из браузера сами при открытии хранилища — кнопки для этого нет: то, что
 * приложение может узнать самостоятельно, оно узнаёт без напоминаний.
 */
export function AccountCards({ access }: { access: AiAccess }): React.JSX.Element | null {
  const all = useAi((s) => s.access)
  const rows = [...familyAccounts(access, all)].sort((x, y) => {
    const a = x.account
    const b = y.account
    if (Boolean(a.primary) !== Boolean(b.primary)) return a.primary ? -1 : 1
    // Подтверждённые выше: список нужен, чтобы найти рабочий аккаунт, а не полный перечень почт.
    if (Boolean(a.verified) !== Boolean(b.verified)) return a.verified ? -1 : 1
    return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
  })
  if (rows.length === 0) return null

  const authorized = rows.filter((r) => r.account.hasPassword || r.account.hasKey).length
  const confirmed = rows.filter((r) => r.account.verified).length

  return (
    <section>
      <h3 className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
          Аккаунты · {rows.length}
        </span>
        <span className="text-[11px] text-slate-600">
          {confirmed === rows.length ? 'все действующие' : `действующих ${confirmed} из ${rows.length}`}
          {authorized < rows.length && ` · с паролем ${authorized}`}
        </span>
      </h3>

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
        {rows.map((r) => (
          <AccountCard
            key={r.account.email}
            access={access}
            account={r.account}
            ownerId={r.accessId}
            ownerLabel={r.accessLabel}
          />
        ))}
      </div>

      {authorized < rows.length && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-slate-600">
          <KeyRound className="h-3 w-3" />
          Пароли подтягиваются из браузера при запуске — те, что без доступа, там не нашлись.
        </p>
      )}
    </section>
  )
}
