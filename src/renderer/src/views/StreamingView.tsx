import { MonitorPlay, Cast, Smartphone } from 'lucide-react'
import { Page, PageHeader, Card, LimitNote, SourceBadge } from '@/components/ui/Page'
import { useDevices } from '@/store/devices'

export function StreamingView(): React.JSX.Element {
  const devices = useDevices((s) => s.devices)

  return (
    <Page>
      <PageHeader title="Streaming" subtitle="remote screens over your own SSH tunnel" />
      <LimitNote>
        MVP-подход: <b className="text-slate-200">noVNC</b> к VNC сервера, протуннелированный через SSH
        этого же приложения (порт наружу не выходит). RDP / Android scrcpy / WebRTC — отдельные модули позже.
      </LimitNote>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {devices.map((d) => (
          <Card key={d.id} className="flex flex-col">
            <div className="flex items-center gap-2">
              {d.flag && <span className="text-sm">{d.flag}</span>}
              <span className="truncate font-semibold text-white">{d.name}</span>
            </div>
            <div className="mt-1 font-mono text-xs text-slate-500">
              {d.user}@{d.ip || '—'}
            </div>
            <div className="mt-4 flex aspect-video items-center justify-center rounded-lg border border-dashed border-border bg-bg/40 text-slate-600">
              <MonitorPlay className="h-7 w-7" />
            </div>
            <button
              disabled
              className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-card px-3 py-2 text-xs font-medium text-slate-400 ring-1 ring-border"
            >
              <Cast className="h-4 w-4" /> Open VNC (SSH tunnel) <SourceBadge kind="soon" />
            </button>
          </Card>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-2 text-xs text-slate-500">
        <Smartphone className="h-4 w-4" /> Свои девайсы (Android через scrcpy) — отдельный модуль позже.
      </div>
    </Page>
  )
}
