import { useEffect, useState } from 'react'
import { AlertTriangle, CircleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI, type ViewId } from '@/store/ui'

// Полоса тревог над списком машин.
//
// Уведомление системы легко пропустить или закрыть не глядя — особенно если приложение было
// свёрнуто. Поэтому то же самое видно и внутри: открыл Argus и сразу знаешь, что не так,
// не обходя карточки по одной.
//
// Но «видно» и «кричит» — разные вещи. Сторож считает тревоги сразу по всем разделам (машины,
// подписки, ИИ-доступы), а полоса вываливала их скопом поверх парка. На живых данных это давало
// постоянно горящие жёлтые и красные строки НЕ ПРО ПАРК: «остаток $0.21», «доступ так и не
// оформлен» — такие висят месяцами, потому что чинить их владелец не собирается, а закрыть их
// нечем. Строка, которая горит всегда, не сообщает ничего: к ней привыкают и перестают читать
// полосу целиком — вместе с той единственной строкой, ради которой она делалась.
//
// Отсюда правило: строкой показывается то, что чинят на ЭТОМ экране, остальное сворачивается в
// счётчик со ссылкой в свой раздел. Ни одна тревога при этом не теряется — сторож по-прежнему
// шлёт уведомление системы (watchdog.ts), а «Подписки» и «ИИ» показывают свои строки у себя.

interface Alert {
  key: string
  kind: string
  title: string
  body: string
  severity: 'warning' | 'critical'
  deviceId?: string
}

/**
 * Тревоги, о которых на этом экране уже сказано другим способом.
 *
 * `device-offline` дублирует сразу две вещи: красную метку «Выключен» на самой карточке (плюс
 * погашенный портрет) и счётчик «N не отвечают» в шапке. Три сообщения об одном факте не делают
 * его втрое заметнее — они делают полосу длинной ровно в тот момент, когда её надо читать
 * внимательнее всего.
 */
const SHOWN_ELSEWHERE = new Set<string>(['device-offline'])

/** Тревоги чужих разделов: где их чинят и как называется пункт меню. */
const OTHER_VIEW: Record<string, { view: ViewId; label: string }> = {
  'renewal-soon': { view: 'subscriptions', label: 'Подписки' },
  'ai-key-expiring': { view: 'ai', label: 'ИИ' },
  'ai-key-dead': { view: 'ai', label: 'ИИ' },
  'ai-credit-low': { view: 'ai', label: 'ИИ' },
  'ai-access-idle': { view: 'ai', label: 'ИИ' }
}

const api = typeof window !== 'undefined' ? window.api : undefined

export function AlertStrip(): React.JSX.Element | null {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const setView = useUI((s) => s.setView)

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

  // Незнакомый вид тревоги показывается строкой, а не прячется: новое правило сторожа должно
  // быть видно сразу. Молчаливое исчезновение из-за того, что вид забыли внести в разбор, —
  // ровно та ошибка, которую невозможно заметить глазами.
  const rows = alerts.filter((a) => !SHOWN_ELSEWHERE.has(a.kind) && !OTHER_VIEW[a.kind])

  // Чужие разделы — одним счётчиком на раздел: сколько и куда идти.
  const counters = new Map<ViewId, { label: string; count: number }>()
  for (const a of alerts) {
    const home = OTHER_VIEW[a.kind]
    if (!home) continue
    const seen = counters.get(home.view)
    counters.set(home.view, { label: home.label, count: (seen?.count ?? 0) + 1 })
  }

  if (rows.length === 0 && counters.size === 0) return null

  // Срочное — выше: если строк несколько, глаз должен упасть на важное.
  const sorted = [...rows].sort((a, b) =>
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

      {counters.size > 0 && (
        // Нарочно серым и мелким: это не тревога парка, а напоминание, что в соседнем разделе
        // есть работа. Цветом такая строка соревновалась бы с настоящей поломкой сервера.
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span>Требует внимания в других разделах:</span>
          {[...counters].map(([view, c]) => (
            <button
              key={view}
              onClick={() => setView(view)}
              className="rounded-md px-2 py-0.5 text-slate-400 ring-1 ring-border transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              {c.label} <span className="tabular-nums">{c.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
