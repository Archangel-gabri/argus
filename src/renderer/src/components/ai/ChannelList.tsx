import { Globe, KeyRound, ShieldAlert, SquareCode, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { AiAccess, AiChannel } from '@/types'

const ICON: Record<AiChannel['kind'], typeof Globe> = {
  web: Globe,
  cli: TerminalSquare,
  api: KeyRound,
  ide: SquareCode
}

const KIND_LABEL: Record<AiChannel['kind'], string> = {
  web: 'веб',
  cli: 'терминал',
  api: 'ключ',
  ide: 'редактор'
}

/**
 * Каналы аккаунта: чем на нём пользуются.
 *
 * Веб-версия, CLI-агент и ключ API — это не три доступа, а три двери в один аккаунт: тариф,
 * лимиты и деньги у них общие. Раньше они были отдельными записями реестра, и одна квота
 * показывалась дважды — у «ChatGPT» и у «Codex CLI».
 */
export function ChannelList({ access }: { access: AiAccess }): React.JSX.Element | null {
  if (access.channels.length === 0) return null

  return (
    <section>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
        Чем пользуюсь · {access.channels.length}
      </h3>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
        {access.channels.map((ch) => {
          const Icon = ICON[ch.kind] ?? Globe
          return (
            <div
              key={ch.label}
              className={cn(
                'rounded-lg border p-3',
                ch.thirdParty ? 'border-amber-500/25 bg-amber-500/[0.04]' : 'border-border bg-card/40'
              )}
            >
              <div className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-200">{ch.label}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                  {KIND_LABEL[ch.kind] ?? ch.kind}
                </span>
              </div>

              <div className="mt-1.5 space-y-1 text-[11px] text-slate-400">
                {ch.tool && ch.tool !== ch.label && <div>инструмент: {ch.tool}</div>}
                {ch.baseUrl && <div className="break-all">{ch.baseUrl}</div>}
                {ch.hasKey && <div>ключ сохранён{ch.keyRef ? ` · ${ch.keyRef}` : ''}</div>}
                {ch.thirdParty && (
                  <div className="flex items-start gap-1 text-amber-400/80">
                    <ShieldAlert className="mt-px h-3 w-3 shrink-0" />
                    через посредника — он видит всё отправленное
                  </div>
                )}
                {ch.notes && <div className="leading-snug">{ch.notes}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
