import { useState } from 'react'
import { Loader2, Wand2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Hint } from '@/components/ui/Hint'
import { inputCls, type FillFields } from '@/components/device/form-fields'
import { useAlive } from '@/components/device/useAlive'

const api = typeof window !== 'undefined' ? window.api : undefined

/**
 * ИИ-заполнение: вставленный текст → локальная Ollama → мёржим непустые поля (превью, юзер правит).
 *
 * `onDraft` сообщает форме, что здесь начали набирать: набранный, но ещё не разобранный текст —
 * это тоже начатая работа, и клик по подложке не должен её уничтожать.
 */
export function AssistPanel({ onFill, onDraft }: { onFill: FillFields; onDraft: (started: boolean) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const alive = useAlive()

  const parse = async (): Promise<void> => {
    if (!api || !text.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.assist.parseDevice(text)
      if (!alive.current) return
      if (!r.ok || !r.fields) {
        setMsg(`✖ ${r.error ?? 'не удалось'}`)
        return
      }
      const x = r.fields
      onFill((p) => ({
        ...p,
        name: x.name ?? p.name,
        provider: x.provider ?? p.provider,
        kind: x.kind ?? p.kind,
        ip: x.ip ?? p.ip,
        port: x.port != null ? String(x.port) : p.port,
        user: x.user ?? p.user,
        os: x.os ?? p.os,
        country: x.country ?? p.country,
        flag: x.flag ?? p.flag,
        consoleUrl: x.consoleUrl ?? p.consoleUrl,
        amount: x.cost?.amount != null ? String(x.cost.amount) : p.amount,
        currency: x.cost?.currency ?? p.currency
      }))
      const filled = Object.keys(x).length
      setMsg(`✓ заполнено полей: ${filled}${r.model ? ` · ${r.model}` : ''} — проверь и поправь`)
    } catch (cause) {
      if (alive.current) setMsg(`✖ ${cause instanceof Error ? cause.message : 'не удалось разобрать текст'}`)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-accent/20 bg-accent/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-accent">
        <Wand2 className="h-3.5 w-3.5" /> Заполнить по тексту (локальный ИИ)
        {/* Было постоянным абзацем под полем. Знать это нужно один раз, а занимало
            место всегда — поэтому под «?». */}
        <Hint>Разбор идёт локально, текст никуда не уходит.</Hint>
      </div>
      <textarea
        aria-label="Текст для локального заполнения"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onDraft(e.target.value.trim().length > 0)
        }}
        placeholder="ssh user@host -p 2222, конфиг, письмо хостера — разберётся в поля"
        className={cn(inputCls, 'h-16 resize-y text-xs')}
        spellCheck={false}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void parse()}
          disabled={busy || !text.trim()}
          className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-bg hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          Заполнить
        </button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
      </div>
    </div>
  )
}
