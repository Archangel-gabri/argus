import { useState } from 'react'
import { Check, Copy, ExternalLink, Key, KeyRound, Loader2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAi } from '@/store/ai'
import type { AiAccess, AiAccountEntry } from '@/types'

/** Куда идти логиниться, если у записи не задан свой адрес. */
const LOGIN_URL: Record<string, string> = {
  openai: 'https://chatgpt.com/auth/login',
  anthropic: 'https://claude.ai/login',
  gemini: 'https://aistudio.google.com/',
  deepseek: 'https://platform.deepseek.com/sign_in',
  openrouter: 'https://openrouter.ai/settings/credits',
  github: 'https://github.com/login',
  cursor: 'https://cursor.com/dashboard',
  mistral: 'https://console.mistral.ai/',
  groq: 'https://console.groq.com/',
  cerebras: 'https://cloud.cerebras.ai/',
  modelscope: 'https://www.modelscope.cn/my/myaccesstoken',
  nvidia_nim: 'https://build.nvidia.com/',
  tavily: 'https://app.tavily.com/',
  exa: 'https://dashboard.exa.ai/',
  firecrawl: 'https://www.firecrawl.dev/app'
}

/** Платный тариф выделяется: именно его ищут, открывая этот список. */
function isPaid(plan?: string): boolean {
  return Boolean(plan) && !/free|бесплат|не провер|неизвест|нет\b/i.test(plan ?? '')
}

function verdictIcon(status?: string): { Icon: typeof Key; tone: string; title: string } | null {
  if (!status) return null
  if (status === 'valid') return { Icon: ShieldCheck, tone: 'text-emerald-400', title: 'ключ принимается' }
  if (status === 'quota') return { Icon: ShieldCheck, tone: 'text-amber-400', title: 'лимит исчерпан, ключ живой' }
  if (status === 'invalid') return { Icon: XCircle, tone: 'text-rose-400', title: 'ключ не принимается' }
  return null
}

function AccountRow({ access, account }: { access: AiAccess; account: AiAccountEntry }): React.JSX.Element {
  const copyPassword = useAi((s) => s.copyAccountPassword)
  const checkKey = useAi((s) => s.checkAccountKey)
  const [copied, setCopied] = useState(false)
  const [checking, setChecking] = useState(false)

  const url = account.loginUrl || LOGIN_URL[access.provider.toLowerCase()]
  const verdict = verdictIcon(account.checkStatus)

  const onCopy = async (): Promise<void> => {
    const ok = await copyPassword(access.id, account.email)
    if (!ok) return
    // Подтверждение живёт полторы секунды: дольше — и человек не понимает, к какой строке оно.
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const onCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await checkKey(access.id, account.email)
    } finally {
      setChecking(false)
    }
  }

  return (
    <li className="group flex items-center gap-2 py-1.5">
      <span
        className={cn('h-1 w-1 shrink-0 rounded-full', account.primary ? 'bg-accent' : 'bg-slate-700')}
        title={account.primary ? 'основной' : undefined}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] text-slate-300" title={account.note}>
        {account.email}
      </span>

      {verdict && (
        <span title={verdict.title} className="flex shrink-0">
          <verdict.Icon className={cn('h-3 w-3', verdict.tone)} />
        </span>
      )}

      <span
        className={cn(
          'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
          isPaid(account.plan) ? 'bg-accent/15 text-accent' : 'text-slate-600'
        )}
      >
        {account.plan || 'тариф неизвестен'}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {account.hasPassword && (
          <button
            onClick={() => void onCopy()}
            title="Скопировать пароль"
            className="rounded p-1 text-slate-600 hover:bg-white/5 hover:text-slate-200"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
        )}
        {account.hasKey && (
          <button
            onClick={() => void onCheck()}
            disabled={checking}
            title="Проверить ключ этого аккаунта"
            className="rounded p-1 text-slate-600 hover:bg-white/5 hover:text-slate-200 disabled:opacity-50"
          >
            {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </button>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Открыть страницу входа"
            className="rounded p-1 text-slate-600 hover:bg-white/5 hover:text-slate-200"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </span>
    </li>
  )
}

/**
 * Аккаунты внутри доступа: у каждого свой тариф, свой пароль и, если есть, свой ключ.
 *
 * Пароли лежат в зашифрованном вольте и наружу не выходят даже здесь — кнопка «скопировать»
 * просит main положить значение в буфер обмена, а интерфейс знает только, что пароль есть.
 */
export function AccountList({ access }: { access: AiAccess }): React.JSX.Element | null {
  const importPasswords = useAi((s) => s.importPasswords)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  if (access.accounts.length === 0) return null

  const withPassword = access.accounts.filter((a) => a.hasPassword).length

  const onImport = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await importPasswords(access.id)
      if (r)
        setResult(
          r.imported === 0
            ? 'В браузере ничего не нашлось'
            : `Импортировано ${r.imported}${r.added ? `, новых аккаунтов ${r.added}` : ''}`
        )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="border-t border-border/60 pt-3">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-600">
          Аккаунты · {access.accounts.length}
        </h3>
        <span className="text-[10px] text-slate-600">
          {withPassword > 0 ? `с паролем ${withPassword}` : 'паролей нет'}
        </span>
      </div>

      <ul className="divide-y divide-border/40">
        {access.accounts.map((a) => (
          <AccountRow key={a.email} access={access} account={a} />
        ))}
      </ul>

      {/* Учётные записи уже лежат в браузере владельца. Переписывать десяток паролей руками —
          верный способ half занести неверно, поэтому импорт делается одной кнопкой. */}
      <button
        onClick={() => void onImport()}
        disabled={busy}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-border py-1 text-[11px] text-slate-600 transition-colors hover:border-accent/40 hover:text-slate-300 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
        Взять пароли из браузера
      </button>
      {result && <p className="mt-1 text-center text-[11px] text-slate-600">{result}</p>}
    </section>
  )
}
