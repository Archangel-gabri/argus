import { cn } from '@/lib/cn'

/**
 * Лента расхода: один штрих на сутки, высота — доля от самого дорогого дня периода.
 *
 * Почему не спарклайн. Ломаная соединяет точки, которых между сутками нет, и в местах простоя
 * рисует наклон, будто расход «плавно снижался». Штрихи не врут: день без запросов — пустое
 * место, и видно, что работа шла рывками.
 *
 * Шкала своя у каждой ленты. Общая по всему экрану сплющила бы дешёвые доступы в ноль, а
 * сравнивать их между собой и не нужно — для этого есть числа рядом.
 */
export function UsageBars({
  data,
  width = 108,
  height = 22,
  className,
  title
}: {
  /** Расход по дням, от старых к новым. */
  data: number[]
  width?: number
  height?: number
  className?: string
  title?: string
}): React.JSX.Element | null {
  if (data.length === 0) return null
  const max = Math.max(...data)
  if (max <= 0) return null

  const gap = data.length > 40 ? 1 : 1.5
  const bar = Math.max(1, (width - gap * (data.length - 1)) / data.length)

  return (
    <svg width={width} height={height} className={cn('overflow-visible', className)} role="img" aria-label={title ?? 'Расход по дням'}>
      {data.map((v, i) => {
        // Минимальная видимая высота у ненулевого дня: иначе «было немного» выглядит как «не было».
        const h = v > 0 ? Math.max(1.5, (v / max) * height) : 0
        return (
          <rect
            key={i}
            x={i * (bar + gap)}
            y={height - h}
            width={bar}
            height={h}
            rx={bar > 2 ? 1 : 0}
            className="fill-accent"
            // Свежие дни ярче: взгляд сам идёт к правому краю, где «сейчас».
            opacity={0.35 + 0.65 * ((i + 1) / data.length)}
          />
        )
      })}
    </svg>
  )
}
