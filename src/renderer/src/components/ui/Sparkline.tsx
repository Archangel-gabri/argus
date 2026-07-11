/** Tiny dependency-free line chart for a metric series (e.g. CPU history on a card). */
export function Sparkline({
  data,
  color = '#f59e0b',
  width = 72,
  height = 22
}: {
  data: number[]
  color?: string
  width?: number
  height?: number
}): React.JSX.Element | null {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const step = width / (data.length - 1)
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
  const last = data[data.length - 1]
  const lastY = height - ((last - min) / range) * height
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={width} cy={lastY} r={1.8} fill={color} />
    </svg>
  )
}
