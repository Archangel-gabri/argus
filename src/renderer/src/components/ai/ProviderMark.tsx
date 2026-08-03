import { markFor } from '@/assets/providers/marks'
import { cn } from '@/lib/cn'

/**
 * Знак провайдера.
 *
 * Логотип узнаётся быстрее строки текста — в списке из двадцати доступов это решает. Там, где
 * своего знака нет, рисуется монограмма из двух букв: она намеренно того же размера и веса,
 * чтобы ряд не рассыпался на «с картинкой» и «без картинки».
 */
export function ProviderMark({
  provider,
  label,
  size = 18,
  tinted = false,
  className
}: {
  provider: string
  /** Название записи — из него берутся буквы монограммы. */
  label?: string
  size?: number
  /** Красить фирменным цветом (для крупного знака в панели деталей). */
  tinted?: boolean
  className?: string
}): React.JSX.Element {
  const mark = markFor(provider)
  if (mark)
    return (
      <svg
        viewBox={mark.vb}
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden
        className={cn('shrink-0', className)}
        style={tinted ? { color: mark.tint } : undefined}
      >
        {mark.paths.map((p, i) => (
          <path key={i} d={p.d} fillRule={p.fillRule} clipRule={p.clipRule} opacity={p.opacity} fill={p.fill} />
        ))}
      </svg>
    )

  const letters = (label || provider)
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center font-semibold tracking-tight', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      {letters}
    </span>
  )
}
