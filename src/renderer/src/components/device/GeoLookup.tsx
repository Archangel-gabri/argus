import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import type { FillFields } from '@/components/device/form-fields'
import { useAlive } from '@/components/device/useAlive'

const api = typeof window !== 'undefined' ? window.api : undefined

/**
 * Страна, флаг и хостер по адресу машины.
 *
 * Гео у внешнего ipwho.is запрашивается только по явной кнопке пользователя: IP — часть
 * приватной топологии, поэтому blur/открытие диалога не имеют права отправлять его наружу.
 */
export function GeoLookup({ ip, onFill }: { ip: string; onFill: FillFields }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const alive = useAlive()

  const lookup = async (): Promise<void> => {
    if (!api || !ip.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.net.ipLookup(ip.trim())
      if (!alive.current) return
      if (!r.ok) {
        setMsg(`✖ ${r.error ?? 'не удалось'}`)
        return
      }
      const place = [r.country, r.city].filter(Boolean).join(' · ')
      onFill((p) => ({
        ...p,
        country: place || p.country,
        flag: r.flag || p.flag,
        provider: p.provider.trim() ? p.provider : r.provider ?? p.provider
      }))
      setMsg(`✓ ${r.flag ?? ''} ${place}${r.provider ? ` · ${r.provider}` : ''}${r.asn ? ` · ${r.asn}` : ''}`)
    } catch (cause) {
      if (alive.current) setMsg(`✖ ${cause instanceof Error ? cause.message : 'гео-сервис не ответил'}`)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void lookup()}
        disabled={busy || !ip.trim()}
        className="flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-card-hover disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-accent" />}
        Гео по IP
      </button>
      {/* Кнопки ряда стоят слева, ответы обеих проверок — за ними: в разметке сообщение идёт
          сразу за своей кнопкой, порядок на экране держит `order`. */}
      {msg && <span className="order-1 text-xs text-slate-500">{msg}</span>}
    </>
  )
}
