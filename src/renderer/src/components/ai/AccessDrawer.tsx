import { useRef, useState } from 'react'
import { Activity, KeyRound, LayoutDashboard, ListTree, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useOverlayA11y } from '@/lib/overlay'
import { KIND_LABEL } from '@/lib/ai-account'
import { AccessOverview } from '@/components/ai/panes/AccessOverview'
import { AccessModels } from '@/components/ai/panes/AccessModels'
import { AccessUsage } from '@/components/ai/panes/AccessUsage'
import { AccessKey } from '@/components/ai/panes/AccessKey'
import type { AiAccess } from '@/types'

type Tab = 'overview' | 'models' | 'usage' | 'key'

const TABS: Array<{ id: Tab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'models', label: 'Модели', icon: ListTree },
  { id: 'usage', label: 'Расход', icon: Activity },
  { id: 'key', label: 'Ключ', icon: KeyRound }
]

export function AccessDrawer({ access, onClose }: { access: AiAccess; onClose: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useOverlayA11y({ open: true, onEscape: onClose, containerRef: panelRef, initialFocusRef: closeRef })

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Доступ ${access.label}`}
        className="relative flex h-full w-[46rem] max-w-full flex-col border-l border-border bg-surface shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-white">{access.label}</h2>
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                {KIND_LABEL[access.kind]}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-500">
              {access.account || access.provider}
              {access.plan ? ` · ${access.plan}` : ''}
            </div>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-white"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div role="tablist" aria-label="Разделы доступа" className="flex gap-1 border-b border-border px-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`ai-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`ai-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors',
                tab === t.id
                  ? 'border-accent text-white'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              )}
            >
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>

        {/* Панели монтируются по требованию: у «Моделей» и «Расхода» свои загрузки, и делать их
            для невидимых вкладок незачем. Живых соединений здесь нет, поэтому размонтирование
            при переключении ничего не рвёт — в отличие от drawer устройства с SSH-сессией. */}
        <div
          role="tabpanel"
          id={`ai-panel-${tab}`}
          aria-labelledby={`ai-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {tab === 'overview' && <AccessOverview access={access} />}
          {tab === 'models' && <AccessModels access={access} />}
          {tab === 'usage' && <AccessUsage access={access} />}
          {tab === 'key' && <AccessKey access={access} />}
        </div>
      </div>
    </div>
  )
}
