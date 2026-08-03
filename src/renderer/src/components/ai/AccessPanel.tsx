import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ProviderMark } from '@/components/ai/ProviderMark'
import { AccessSummary } from '@/components/ai/panes/AccessSummary'
import { AccessModels } from '@/components/ai/panes/AccessModels'
import { AccessUsage } from '@/components/ai/panes/AccessUsage'
import { KIND_ONE } from '@/lib/ai-account'
import type { AiAccess } from '@/types'

type Segment = 'summary' | 'models' | 'usage'

// Три раздела, а не четыре: «Ключ» был отдельной вкладкой с четырьмя строками и жил в
// постоянном отрыве от остального описания доступа — теперь он часть обзора.
const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: 'summary', label: 'Обзор' },
  { id: 'models', label: 'Модели' },
  { id: 'usage', label: 'Расход' }
]

export function AccessPanel({
  access,
  onEdit,
  onDelete
}: {
  access: AiAccess
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [segment, setSegment] = useState<Segment>('summary')

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 px-5 pb-3 pt-4">
        <ProviderMark provider={access.provider} label={access.label} size={30} tinted className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-white">{access.label}</h2>
          <p className="mt-0.5 truncate text-[11px] text-slate-600">
            {access.provider} · {KIND_ONE[access.kind]}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onEdit}
            title="Изменить"
            className="rounded p-1.5 text-slate-600 transition-colors hover:bg-white/5 hover:text-slate-200"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDelete}
            title="Удалить"
            className="rounded p-1.5 text-slate-600 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div role="tablist" aria-label="Разделы доступа" className="flex gap-4 border-b border-border px-5">
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={segment === s.id}
            onClick={() => setSegment(s.id)}
            className={cn(
              '-mb-px border-b py-2 text-[12px] transition-colors',
              segment === s.id
                ? 'border-accent font-medium text-white'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Раздел монтируется по требованию: у моделей и расхода свои загрузки, и делать их
          для невидимых вкладок незачем. Живых соединений тут нет, рвать нечего. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {segment === 'summary' && <AccessSummary access={access} />}
        {segment === 'models' && <AccessModels access={access} />}
        {segment === 'usage' && <AccessUsage access={access} />}
      </div>
    </div>
  )
}
