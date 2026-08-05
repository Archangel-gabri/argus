import { useState } from 'react'
import { cn } from '@/lib/cn'
import { plural } from '@/lib/format'
import { useDevices } from '@/store/devices'
import { useUI } from '@/store/ui'
import { ServerCard } from '@/components/ServerCard'
import { InsightsPanel } from '@/components/InsightsPanel'
import { DeviceDialog } from '@/components/DeviceDialog'
import type { DeviceKind } from '@/types'

type FleetGroup = 'all' | 'servers' | 'personal' | 'network'

const groupOf = (k: DeviceKind): Exclude<FleetGroup, 'all'> =>
  k === 'server' ? 'servers' : k === 'router' ? 'network' : 'personal'

// Подписи по-русски, как и весь остальной интерфейс.
const GROUPS: Array<{ id: FleetGroup; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'servers', label: 'Серверы' },
  { id: 'personal', label: 'Свои машины' },
  { id: 'network', label: 'Сеть' }
]

export function DevicesView(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const loadError = useDevices((s) => s.error)
  const loadDevices = useDevices((s) => s.load)
  const refreshMetrics = useDevices((s) => s.refreshMetrics)
  const refreshLiveness = useDevices((s) => s.refreshLiveness)
  const openCreate = useUI((s) => s.openCreate)
  const search = useUI((s) => s.search).trim().toLowerCase()
  const [polling, setPolling] = useState(false)
  const [group, setGroup] = useState<FleetGroup>('all')

  const inGroup = group === 'all' ? devices : devices.filter((d) => groupOf(d.kind) === group)
  const list = search
    ? inGroup.filter((d) =>
        `${d.name} ${d.provider} ${d.country} ${d.ip} ${d.os}`.toLowerCase().includes(search)
      )
    : inGroup
  const onlineCount = devices.filter((d) => d.status === 'online').length
  // Единственная сводка о падении на этом экране. Раньше о том же говорили ещё и полоса тревог
  // (по строке на машину), и метка на карточке — три голоса об одном факте, из-за которых
  // полоса становилась длинной именно тогда, когда её надо читать внимательнее всего.
  const offlineCount = devices.filter((d) => d.status === 'offline').length
  const countOf = (g: FleetGroup): number =>
    g === 'all' ? devices.length : devices.filter((d) => groupOf(d.kind) === g).length

  // Кнопки «Обновить» в шапке больше нет. Парк опрашивается сам — связь раз в 10 секунд, полные
  // метрики раз в 30 (App.tsx), — то есть кнопка обещала действие, которое и так происходит, и
  // чаще всего попадала в уже идущий проход: `refreshMetrics` гасит наложение флагом
  // `metricsInFlight` и в этом случае возвращается сразу, ничего не сделав. Кнопка, которая
  // иногда работает, а иногда молча нет, — хуже отсутствующей.
  //
  // Способ поторопить опрос всё же нужен: подняли ноду руками и ждать десять секунд не хочется.
  // Он остался там, куда в этот момент и смотрят: счётчик «N на связи» сам является кнопкой.
  // Второй путь, для клавиатуры, — ⌘K → «Обновить метрики».
  const onRefresh = async (): Promise<void> => {
    if (polling) return
    setPolling(true)
    try {
      // Живость — вместе с метриками. Полный опрос намеренно обходит машины, уже признанные
      // выключенными (это 10 секунд SSH-таймаута с известным ответом), поэтому без быстрой
      // проверки нажатие не воскресило бы ровно ту машину, ради которой его сделали.
      await Promise.all([refreshLiveness(), refreshMetrics()])
    } finally {
      setPolling(false)
    }
  }

  return (
    <div className="flex h-full">
      <section className="flex-1 overflow-y-auto px-8 py-7">
        <div className="mb-4">
          <h1 className="text-2xl font-semibold text-white">Парк</h1>
          <p className="mt-1 text-sm text-slate-500">
            {devices.length} {plural(devices.length, 'устройство', 'устройства', 'устройств')} ·{' '}
            <button
              onClick={() => void onRefresh()}
              disabled={polling}
              aria-label={`${onlineCount} на связи. Опросить парк сейчас`}
              title="Опросить сейчас. Обычно это происходит само: связь — раз в 10 с, метрики — раз в 30 с."
              className={cn(
                'rounded underline-offset-2 transition-colors hover:text-slate-300 hover:underline',
                polling && 'animate-pulse'
              )}
            >
              {onlineCount} на связи
            </button>
            {offlineCount > 0 && (
              <span className="text-rose-400">
                {' · '}
                {offlineCount}{' '}
                {plural(offlineCount, 'не отвечает', 'не отвечают', 'не отвечают')}
              </span>
            )}
          </p>
        </div>

        <div className="mb-5 flex items-center gap-1.5">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => setGroup(g.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                group === g.id
                  ? 'bg-accent/15 text-accent ring-1 ring-accent/30'
                  : 'text-slate-400 ring-1 ring-border hover:bg-white/5 hover:text-slate-200'
              )}
            >
              {g.label}
              <span className="tabular-nums opacity-70">{countOf(g.id)}</span>
            </button>
          ))}
        </div>

        {/* Отказ чтения и пустой парк — разные вещи, и путать их нельзя: «устройств нет»
            вместо «не удалось прочитать» читается как «база потеряна». Стор эту разницу
            уже различал, а экран её терял. */}
        {loadError ? (
          <div className="rounded-xl border border-dashed border-rose-500/30 py-16 text-center text-sm">
            <p className="text-rose-400">Парк не прочитан: {loadError}</p>
            <button
              onClick={() => void loadDevices()}
              className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-accent/40 hover:text-white"
            >
              Повторить
            </button>
          </div>
        ) : devices.length === 0 ? (
          <button
            onClick={openCreate}
            className="w-full rounded-xl border border-dashed border-border py-16 text-center text-sm text-slate-500 transition-colors hover:border-accent/40 hover:text-slate-300"
          >
            Устройств нет — добавь первое
          </button>
        ) : list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-slate-500">
            Ничего не найдено
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {list.map((d) => (
              <ServerCard key={d.id} s={d} />
            ))}
          </div>
        )}
      </section>

      <aside className="hidden w-[360px] shrink-0 overflow-y-auto border-l border-border bg-surface/40 px-6 py-7 xl:block">
        <InsightsPanel />
      </aside>

      <DeviceDialog />
    </div>
  )
}
