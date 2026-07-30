import { useEffect, useState } from 'react'
import { AlertTriangle, CircleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'

// Полоса тревог над списком машин.
//
// Уведомление системы легко пропустить или закрыть не глядя — особенно если приложение было
// свёрнуто. Поэтому то же самое видно и внутри: открыл Argus и сразу знаешь, что не так,
// не обходя карточки по одной.

interface Alert {
  key: string
  kind: string
  title: string
  body: string
  severity: 'warning' | 'critical'
  deviceId?: string
}

const api = typeof window !== 'undefined' ? window.api : undefined

export function AlertStrip(): React.JSX.Element | null {
  const [alerts, setAlerts] = useState<Alert[]>([])

  useEffect(() => {
    if (!api?.alerts) return
    const read = (): void => {
      void api.alerts.list().then((a) => setAlerts(a as Alert[]))
    }
    read()
    // Сторож проверяет раз в минуту — чаще спрашивать нечего, ответ не изменится.
    const t = setInterval(read, 60_000)
    return () => clearInterval(t)
  }, [])

  if (alerts.length === 0) return null

  // Срочное — выше: если строк несколько, глаз должен упасть на важное.
  const sorted = [...alerts].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1
  )

  return (
    <div className="mb-3 space-y-1.5">
      {sorted.map((a) => (
        <div
          key={a.key}
          className={cn(
            'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
            a.severity === 'critical'
              ? 'border-rose-500/25 bg-rose-500/5 text-rose-200'
              : 'border-amber-400/25 bg-amber-400/5 text-amber-100'
          )}
        >
          {a.severity === 'critical' ? (
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="min-w-0">
            <span className="font-medium">{a.title}</span>
            <span className="ml-1.5 text-slate-400">{a.body}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
