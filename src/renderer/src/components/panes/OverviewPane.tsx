import { useEffect, useState } from 'react'
import { ExternalLink, RotateCw, Power, Moon, Monitor, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { money, pct } from '@/lib/format'
import { deviceIllustration } from '@/lib/illustrations'
import { STATUS, ProviderBadge, KIND_LABEL, isSshCapable } from '@/components/ServerCard'
import { useDevices } from '@/store/devices'
import type { DeviceDTO } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

// Питание через существующий ssh:exec. sudo -n на случай не-root (root-сессии игнорируют sudo).
const PWR = {
  reboot: 'sudo -n systemctl reboot 2>/dev/null || systemctl reboot',
  poweroff: 'sudo -n systemctl poweroff 2>/dev/null || systemctl poweroff',
  suspend: 'sudo -n systemctl suspend 2>/dev/null || systemctl suspend',
  // Ребут в Windows: grub сам находит menuentry с "Windows" (имя записи может отличаться на разных ПК).
  toWindows:
    'e=$(awk -F"\'" \'/menuentry / && /[Ww]indows/{print $2; exit}\' /boot/grub/grub.cfg 2>/dev/null); ' +
    'if [ -n "$e" ]; then sudo -n grub-reboot "$e" && sudo -n systemctl reboot; else echo "Windows entry not found in grub"; fi',
  toLinux: 'sudo -n systemctl reboot 2>/dev/null || systemctl reboot'
}

// Dual-boot ПК: одна карточка, текущая ОС + выбор Linux/Windows + питание на живой ОС.
function DualBootSection({ device: d }: { device: DeviceDTO }): React.JSX.Element {
  const [current, setCurrent] = useState<'linux' | 'windows' | 'off' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const winOs = d.alt?.os || 'Windows'
  const linOs = d.os || 'Linux'

  const refresh = async (): Promise<void> => {
    if (!api) return
    setCurrent(null)
    const r = await api.pc.whichOs(d.id)
    setCurrent(r.current)
  }
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id])

  const doBoot = async (target: 'linux' | 'windows', label: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(`Загрузить ${label} на «${d.name}»?\nПК перезагрузится в выбранную ОС.`)) return
    setBusy('boot-' + target)
    setMsg(null)
    const r = await api.pc.boot(d.id, target)
    setBusy(null)
    setMsg(r.ok ? `✓ ${r.output || 'команда отправлена, ПК перезагружается'}` : `✖ ${r.error}`)
  }
  const doPower = async (action: 'reboot' | 'poweroff' | 'suspend', label: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(`${label} «${d.name}»?`)) return
    setBusy(action)
    setMsg(null)
    const r = await api.pc.power(d.id, action)
    setBusy(null)
    setMsg(r.ok ? '✓ команда отправлена' : `✖ ${r.error}`)
  }

  const badge =
    current === null
      ? { text: 'проверяю…', cls: 'text-slate-500' }
      : current === 'off'
        ? { text: 'выключен / offline', cls: 'text-slate-500' }
        : current === 'windows'
          ? { text: `Сейчас: ${winOs}`, cls: 'text-sky-400' }
          : { text: `Сейчас: ${linOs}`, cls: 'text-emerald-400' }

  const Btn = ({
    id,
    label,
    icon: Icon,
    onClick,
    danger,
    active
  }: {
    id: string
    label: string
    icon: typeof Power
    onClick: () => void
    danger?: boolean
    active?: boolean
  }): React.JSX.Element => (
    <button
      onClick={onClick}
      disabled={!!busy || active}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition-colors disabled:opacity-50',
        active
          ? 'bg-accent/15 text-accent ring-accent/30'
          : danger
            ? 'text-rose-300 ring-rose-500/30 hover:bg-rose-500/10'
            : 'text-slate-200 ring-border hover:bg-white/5'
      )}
    >
      {busy === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  )

  const dotCls =
    current === 'windows' ? 'bg-sky-400' : current === 'linux' ? 'bg-emerald-500' : 'bg-slate-500'

  // Сегмент ОС: активная (запущенная) подсвечена; клик по неактивной — загрузить в неё.
  const Seg = ({ os, label, target }: { os: 'linux' | 'windows'; label: string; target: 'linux' | 'windows' }): React.JSX.Element => {
    const isCurrent = current === os
    const loading = busy === 'boot-' + target
    return (
      <button
        onClick={() => (isCurrent ? undefined : doBoot(target, label))}
        disabled={!!busy || isCurrent}
        title={isCurrent ? 'Запущена сейчас' : `Перезагрузить в ${label}`}
        className={cn(
          'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-colors',
          isCurrent
            ? os === 'windows'
              ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
              : 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
        )}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Monitor className="h-3.5 w-3.5" />}
        {label}
        {isCurrent && <span className={cn('ml-0.5 h-1.5 w-1.5 rounded-full', dotCls)} />}
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Питание и ОС</span>
        <button
          onClick={refresh}
          className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', badge.cls)}
          title="Обновить статус ОС"
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', dotCls)} /> {badge.text}
        </button>
      </div>

      {/* Сегментный выбор ОС */}
      <div className="mb-2.5 flex gap-1 rounded-lg border border-border bg-bg/40 p-1">
        <Seg os="linux" label={linOs} target="linux" />
        <Seg os="windows" label={winOs} target="windows" />
      </div>

      {/* Питание живой ОС */}
      <div className="flex flex-wrap gap-2">
        <Btn id="reboot" label="Ребут" icon={RotateCw} onClick={() => doPower('reboot', 'Ребут')} />
        <Btn id="suspend" label="Сон" icon={Moon} onClick={() => doPower('suspend', 'Сон')} />
        <Btn id="poweroff" label="Выключить" icon={Power} danger onClick={() => doPower('poweroff', 'Выключить')} />
      </div>

      {msg && <div className="mt-2 whitespace-pre-wrap text-[11px] text-slate-500">{msg}</div>}
      <p className="mt-1.5 text-[11px] text-slate-600">
        Клик по неактивной ОС — перезагрузка в неё. «Включить» из выключенного — WoL (MAC есть, добавим).
      </p>
    </div>
  )
}

function PowerSection({ device: d }: { device: DeviceDTO }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const isPc = d.kind === 'pc'

  const run = async (key: string, label: string, cmd: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(`${label} — «${d.name}»?\nДействие выполнится по SSH немедленно.`)) return
    setBusy(key)
    setMsg(null)
    const r = await api.ssh.exec(d.id, cmd)
    setBusy(null)
    // reboot/poweroff рвут соединение → пустой ok:false ожидаем; трактуем как «отправлено».
    if (r.output?.trim()) setMsg(r.output.trim())
    else if (r.error && !/closed|disconnect|ECONNRESET|timed out/i.test(r.error)) setMsg(`✖ ${r.error}`)
    else setMsg('✓ команда отправлена')
  }

  const Btn = ({
    id,
    label,
    icon: Icon,
    cmd,
    danger
  }: {
    id: string
    label: string
    icon: typeof Power
    cmd: string
    danger?: boolean
  }): React.JSX.Element => (
    <button
      onClick={() => run(id, label, cmd)}
      disabled={!!busy}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition-colors disabled:opacity-50',
        danger
          ? 'text-rose-300 ring-rose-500/30 hover:bg-rose-500/10'
          : 'text-slate-200 ring-border hover:bg-white/5'
      )}
    >
      {busy === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  )

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Питание</div>
      <div className="flex flex-wrap gap-2">
        <Btn id="reboot" label="Ребут" icon={RotateCw} cmd={PWR.reboot} />
        <Btn id="suspend" label="Сон" icon={Moon} cmd={PWR.suspend} />
        <Btn id="poweroff" label="Выключить" icon={Power} cmd={PWR.poweroff} danger />
        {isPc && (
          <>
            <Btn id="win" label="→ Windows" icon={Monitor} cmd={PWR.toWindows} />
            <Btn id="lin" label="→ Linux" icon={Monitor} cmd={PWR.toLinux} />
          </>
        )}
      </div>
      {msg && <div className="mt-2 whitespace-pre-wrap text-[11px] text-slate-500">{msg}</div>}
      {isPc && (
        <p className="mt-1.5 text-[11px] text-slate-600">
          «Включить» из выключенного — через Wake-on-LAN (нужен MAC + сеть); добавим отдельно.
        </p>
      )}
    </div>
  )
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}д ${h}ч`
  if (h > 0) return `${h}ч ${m}м`
  return `${m}м`
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/50 px-3 py-2">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 truncate text-sm text-slate-200">{value || '—'}</div>
    </div>
  )
}

export function OverviewPane({ device: d }: { device: DeviceDTO }): React.JSX.Element {
  const devices = useDevices((s) => s.devices)
  const refreshOne = useDevices((s) => s.refreshOne)
  const st = STATUS[d.status]

  // Учащённый live-опрос пока карточка открыта (каждые 12с) — метрики «в реальном времени».
  useEffect(() => {
    if (!isSshCapable(d.kind)) return
    refreshOne(d.id)
    const t = setInterval(() => refreshOne(d.id), 12000)
    return () => clearInterval(t)
  }, [d.id, d.kind, refreshOne])
  const jump = d.jumpId ? (devices.find((x) => x.id === d.jumpId)?.name ?? d.jumpId) : null
  const ramPct = d.ram.total ? (d.ram.used / d.ram.total) * 100 : 0
  const ssh = isSshCapable(d.kind)

  return (
    <div className="h-full space-y-4 overflow-y-auto pr-1">
      <div
        className="relative h-56 overflow-hidden rounded-xl bg-bg"
        style={{ boxShadow: `inset 0 0 0 1px ${st.hex}33` }}
      >
        <div
          className="pointer-events-none absolute inset-x-12 bottom-3 h-20"
          style={{ background: 'radial-gradient(ellipse at center, var(--color-glow) 0%, transparent 70%)' }}
        />
        <img src={deviceIllustration(d.kind, d.role)} alt="" className="mx-auto h-full object-contain py-3" draggable={false} />
        <div className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm">
          <span className={cn('h-1.5 w-1.5 rounded-full', st.dot, d.status === 'reboot' && 'animate-pulse')} />
          <span className={cn('text-[11px] font-medium leading-none', st.text)}>{st.label}</span>
        </div>
        <div className="absolute right-3 top-3">
          <ProviderBadge provider={d.provider} />
        </div>
        {d.flag && (
          <span className="absolute bottom-3 left-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-base leading-none ring-1 ring-white/10 backdrop-blur-sm">
            {d.flag}
          </span>
        )}
      </div>

      {ssh ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Fact label={d.alt ? 'Сейчас ОС' : 'OS'} value={d.runningOs || d.os} />
            <Fact label="Страна" value={d.country} />
            <Fact label="Хост" value={`${d.ip || '—'}:${d.port}`} />
            <Fact label="Пользователь" value={d.user} />
            <Fact
              label="Авторизация"
              value={d.authType === 'key' ? 'SSH-ключ' : d.authType === 'password' ? 'пароль' : 'нет'}
            />
            <Fact label="Jump-host" value={jump ?? '—'} />
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card/50 p-3 text-xs">
            <div>
              <div className="mb-1 flex justify-between">
                <span className="text-slate-500">CPU</span>
                <span className="tabular-nums text-slate-200">{pct(d.cpu)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-600/30">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(2, d.cpu))}%` }} />
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between">
                <span className="text-slate-500">RAM</span>
                <span className="tabular-nums text-slate-200">
                  {d.ram.used}/{d.ram.total} GB
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-600/30">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(2, ramPct))}%` }} />
              </div>
            </div>
          </div>

          {(d.disk != null || d.uptime != null) && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card/50 p-3 text-xs">
              {d.disk != null ? (
                <div>
                  <div className="mb-1 flex justify-between">
                    <span className="text-slate-500">Диск /</span>
                    <span className="tabular-nums text-slate-200">{d.disk}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-600/30">
                    <div
                      className={cn('h-full rounded-full', d.disk > 90 ? 'bg-rose-500' : d.disk > 75 ? 'bg-amber-400' : 'bg-accent')}
                      style={{ width: `${Math.min(100, Math.max(2, d.disk))}%` }}
                    />
                  </div>
                </div>
              ) : (
                <div />
              )}
              <div className="flex flex-col justify-center">
                <span className="text-slate-500">Аптайм</span>
                <span className="tabular-nums text-slate-200">{d.uptime != null ? fmtUptime(d.uptime) : '—'}</span>
              </div>
            </div>
          )}

          {d.kind === 'pc' && d.alt ? <DualBootSection device={d} /> : <PowerSection device={d} />}
        </>
      ) : (
        // Паспорт-устройство: показываем то, что осмысленно, без SSH-полей и метрик.
        <>
          <div className="grid grid-cols-2 gap-2">
            <Fact label="Тип" value={KIND_LABEL[d.kind]} />
            <Fact label="Бренд" value={d.provider} />
            <Fact label="Модель / OS" value={d.os} />
            <Fact label="Где" value={d.country} />
          </div>
          <div className="rounded-lg border border-border bg-card/50 px-3 py-2.5 text-xs text-slate-500">
            Живые данные (батарея, сигнал, экран) — этап C: KDE Connect для телефона/наушников,
            WoL/OS-switch для ПК. Пока это карточка-паспорт (модель, доступы, заметки).
          </div>
        </>
      )}

      <div className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-3 py-2.5">
        {d.consoleUrl ? (
          <a
            href={d.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-hover"
          >
            <ExternalLink className="h-3.5 w-3.5" /> {ssh ? 'Hoster Console' : 'Открыть панель'}
          </a>
        ) : (
          <span className="text-xs text-slate-600">Без панели</span>
        )}
        {d.cost.amount > 0 && (
          <span className="text-xs font-medium tabular-nums text-slate-300">
            {money(d.cost.amount, d.cost.currency)}
            <span className="text-slate-500">/mo · ${d.cost.usd} норм.</span>
          </span>
        )}
      </div>

      {d.notes && (
        <p className="whitespace-pre-wrap rounded-lg border border-border bg-card/50 p-3 text-xs text-slate-400">{d.notes}</p>
      )}
    </div>
  )
}
