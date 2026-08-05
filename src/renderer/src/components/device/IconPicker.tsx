import { cn } from '@/lib/cn'
import { ILLUSTRATIONS, defaultIllustrationKey } from '@/lib/illustrations'
import type { DeviceKind } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

/** Ряд портретов: встроенные + своя картинка + «авто». */
export function IconPicker({
  value,
  kind,
  role,
  onPick
}: {
  value: string
  kind: DeviceKind
  role: string
  onPick: (v: string) => void
}): React.JSX.Element {
  const autoKey = defaultIllustrationKey(kind, role || null)
  const custom = value.startsWith('data:') ? value : null

  const pickCustom = async (): Promise<void> => {
    const r = await api?.devices.pickIcon()
    if (r?.ok && r.dataUrl) onPick(r.dataUrl)
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onPick('')}
        title="Авто — по типу и роли устройства"
        aria-label="Авто — по типу и роли"
        aria-pressed={value === ''}
        className={cn(
          'h-11 w-11 overflow-hidden rounded-lg ring-1 transition-colors',
          value === '' ? 'ring-2 ring-accent' : 'ring-border hover:ring-slate-500'
        )}
      >
        <img src={ILLUSTRATIONS.find((i) => i.key === autoKey)?.src} alt="авто" className="h-full w-full object-contain opacity-70" />
      </button>
      {ILLUSTRATIONS.map((ill) => (
        <button
          key={ill.key}
          type="button"
          onClick={() => onPick(ill.key)}
          title={ill.label}
          aria-label={ill.label}
          aria-pressed={value === ill.key}
          className={cn(
            'h-11 w-11 overflow-hidden rounded-lg ring-1 transition-colors',
            value === ill.key ? 'ring-2 ring-accent' : 'ring-border hover:ring-slate-500'
          )}
        >
          <img src={ill.src} alt={ill.label} className="h-full w-full object-contain" />
        </button>
      ))}
      {custom && (
        <button
          type="button"
          title="Своя картинка"
          aria-label="Своя картинка"
          aria-pressed
          className="h-11 w-11 overflow-hidden rounded-lg ring-2 ring-accent"
          onClick={() => onPick(custom)}
        >
          <img src={custom} alt="своя" className="h-full w-full object-cover" />
        </button>
      )}
      <button
        type="button"
        onClick={() => void pickCustom()}
        className="h-11 rounded-lg px-3 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-white/5"
      >
        Своя картинка…
      </button>
    </div>
  )
}
