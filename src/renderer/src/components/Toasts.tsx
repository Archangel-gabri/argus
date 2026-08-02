import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useToasts, TOAST_TTL_MS, type Toast } from '@/store/toasts'

// Видимый исход действия.
//
// Раньше неудача почти любой операции была неотличима от медленной операции: человек нажимал
// кнопку, и не происходило ничего. Здесь у каждого действия появляется ответ.
//
// Про доступность. Ошибка объявляется немедленно (`alert`), успех и справка — в порядке
// очереди (`status`): перебивать чтение экрана ради «сохранено» невежливо, а ради «не удалось
// перезагрузить сервер» — необходимо. Область помечена `aria-live`, потому что сообщения
// появляются без действия пользователя, и без этого программа чтения о них не узнает вовсе.

const LOOK: Record<Toast['kind'], { box: string; icon: typeof Info }> = {
  error: { box: 'border-rose-500/30 bg-rose-500/10 text-rose-100', icon: AlertTriangle },
  success: { box: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100', icon: CheckCircle2 },
  info: { box: 'border-amber-400/25 bg-amber-400/5 text-amber-100', icon: Info }
}

function ToastRow({ toast }: { toast: Toast }): React.JSX.Element {
  const dismiss = useToasts((s) => s.dismiss)
  const { box, icon: Icon } = LOOK[toast.kind]

  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), TOAST_TTL_MS[toast.kind])
    return () => clearTimeout(t)
  }, [toast.id, toast.kind, dismiss])

  return (
    <div
      // Ошибку объявляем сразу: она про то, что уже не произошло, и ждать очереди незачем.
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-2 rounded-lg border px-3 py-2.5 text-xs shadow-lg backdrop-blur',
        box
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{toast.text}</div>
        {toast.detail && (
          // Подробность от main не прячем: без неё «не удалось» не даёт ни одной зацепки.
          <div className="mt-0.5 break-words text-[11px] text-slate-300/80">{toast.detail}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Закрыть сообщение"
        className="shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:text-slate-200 focus-visible:outline focus-visible:outline-1 focus-visible:outline-current"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function Toasts(): React.JSX.Element | null {
  const toasts = useToasts((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div
      aria-live="polite"
      aria-relevant="additions text"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  )
}
