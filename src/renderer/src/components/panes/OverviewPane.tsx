import { useEffect, useState, useCallback } from 'react'
import {
  ExternalLink,
  RotateCw,
  Power,
  Moon,
  Monitor,
  Loader2,
  Zap,
  Stethoscope,
  AlertTriangle,
  Gauge,
  ArrowDownUp,
  Layers,
  Thermometer,
  Cpu,
  MemoryStick,
  HardDrive,
  CircuitBoard,
  MonitorCog,
  Server,
  RefreshCw
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { money, pct } from '@/lib/format'
import { deviceIllustration } from '@/lib/illustrations'
import { STATUS, ProviderBadge, KIND_LABEL, isSshCapable } from '@/components/ServerCard'
import { useDevices } from '@/store/devices'
import type { DeviceDTO, PowerResult, HardwareInfo } from '@/types'

const api = typeof window !== 'undefined' ? window.api : undefined

// Человекочитаемое сообщение по двухфазному результату питания (main/pc.ts).
function powerMsg(r: PowerResult): string {
  switch (r.phase) {
    case 'verified':
      return r.output || '✓ выполнено'
    case 'accepted':
      return r.output || '✓ команда отправлена'
    case 'rejected':
      return `✖ отклонено хостом: ${r.error}`
    case 'still-up':
      return `⚠ ${r.error}`
    case 'no-endpoint':
      return `✖ ${r.error}`
    default:
      return r.ok ? '✓' : `✖ ${r.error ?? 'не удалось'}`
  }
}
// После неуспеха показываем кнопку «Диагностика».
const powerFailed = (r: PowerResult): boolean => r.phase === 'rejected' || r.phase === 'still-up'

/** Есть ли чем разбудить устройство обратно. Wake-on-LAN работает только в своей L2-сети и
 *  только при заданном MAC — у VPS его нет, значит выключение необратимо средствами Argus. */
const hasWakePath = (d: DeviceDTO): boolean => !!d.mac

/** Постоянная пометка под кнопками, чтобы тупик был виден ДО клика, а не только в диалоге. */
function OneWayHint(): React.JSX.Element {
  return (
    <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-200/70">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        «Выключить» и «Сон» здесь необратимы: Wake-on-LAN недоступен без MAC, поднимать придётся
        вручную (панель хостера или сама машина).
      </span>
    </div>
  )
}

/** Текст подтверждения. Для необратимых действий говорим прямо, чем это кончится, — иначе
 *  приложение само заводит в тупик: «Выключить» есть, а «Включить» не появится. */
function confirmPowerText(d: DeviceDTO, action: 'reboot' | 'poweroff' | 'suspend', label: string): string {
  const head = `${label} — «${d.name}»?`
  if (action === 'reboot') return `${head}\nКоманда уйдёт по SSH на живую ОС.`
  if (hasWakePath(d)) return `${head}\nПоднять обратно можно кнопкой «Включить» (Wake-on-LAN).`
  const back = 'ВЕРНУТЬ ИЗ ARGUS БУДЕТ НЕЧЕМ: MAC не задан, Wake-on-LAN недоступен.\nВключать придётся вручную — из панели хостера или с самой машины.'
  return action === 'suspend'
    ? `${head}\n\n${back}\n\nДля виртуального сервера сон ХУЖЕ выключения: машина повиснет в спячке, и панель хостера сможет только принудительно её сбросить.`
    : `${head}\n\n${back}`
}

// Multi-boot ПК: одна карточка, текущая ОС + выбор из N ОС + питание на живой ОС.
function DualBootSection({ device: d }: { device: DeviceDTO }): React.JSX.Element {
  const [current, setCurrent] = useState<string | null>(null) // метка живой ОС; '' = off; null = проверяю
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [diag, setDiag] = useState<string | null>(null)
  // Все ОС этой железки: основная (d.os) + доп. (d.altOs).
  const osList = [d.os || 'Linux', ...d.altOs.map((a) => a.os || 'OS')]
  const famOf = (os: string): 'windows' | 'linux' => (/win/i.test(os) ? 'windows' : 'linux')

  const refresh = async (): Promise<void> => {
    if (!api) return
    setCurrent(null)
    const r = await api.pc.whichOs(d.id)
    setCurrent(r.current)
  }
  // Опрашиваем живую ОС на маунте И каждые 15с, пока карточка открыта — иначе после ребута/
  // boot-switch сегмент «Сейчас: …» навсегда показывал ОС на момент открытия drawer.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id])

  const doBoot = async (targetOs: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(`Загрузить ${targetOs} на «${d.name}»?\nПК перезагрузится в выбранную ОС.`)) return
    setBusy('boot-' + targetOs)
    setMsg(null)
    const r = await api.pc.boot(d.id, targetOs)
    setBusy(null)
    setMsg(r.ok ? `✓ ${r.output || 'команда отправлена, ПК перезагружается'}` : `✖ ${r.error}`)
  }
  const doPower = async (action: 'reboot' | 'poweroff' | 'suspend', label: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(confirmPowerText(d, action, label))) return
    setBusy(action)
    setMsg(null)
    setDiag(null)
    setFailed(false)
    const r = await api.pc.power(d.id, action)
    setBusy(null)
    setMsg(powerMsg(r))
    setFailed(powerFailed(r))
    refresh() // сразу перечитать живую ОС (после ребута/выключения статус обновится)
  }
  const doWake = async (): Promise<void> => {
    if (!api) return
    setBusy('wake')
    setMsg(null)
    setDiag(null)
    const r = await api.pc.wake(d.id)
    setBusy(null)
    setMsg(r.ok ? '✓ magic-пакет отправлен (WoL) — ПК должен проснуться (из сна S3, не из полного выкл.)' : `✖ ${r.error}`)
  }
  const doDiag = async (): Promise<void> => {
    if (!api) return
    setBusy('diag')
    setDiag(null)
    const r = await api.pc.powerDiag(d.id)
    setBusy(null)
    setDiag(r.text || '(нет данных)')
  }

  const badge =
    current === null
      ? { text: 'проверяю…', cls: 'text-slate-500' }
      : current === ''
        ? { text: 'выключен / offline', cls: 'text-slate-500' }
        : { text: `Сейчас: ${current}`, cls: famOf(current) === 'windows' ? 'text-sky-400' : 'text-emerald-400' }

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
    current && famOf(current) === 'windows' ? 'bg-sky-400' : current ? 'bg-emerald-500' : 'bg-slate-500'

  // Сегмент ОС: активная (запущенная) подсвечена; клик по неактивной — загрузить в неё.
  const Seg = ({ osLabel }: { osLabel: string }): React.JSX.Element => {
    const isCurrent = current === osLabel
    const loading = busy === 'boot-' + osLabel
    const fam = famOf(osLabel)
    return (
      <button
        onClick={() => (isCurrent ? undefined : doBoot(osLabel))}
        disabled={!!busy || isCurrent}
        title={isCurrent ? 'Запущена сейчас' : `Перезагрузить в ${osLabel}`}
        className={cn(
          'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-colors',
          isCurrent
            ? fam === 'windows'
              ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
              : 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
        )}
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Monitor className="h-3.5 w-3.5" />}
        {osLabel}
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

      {/* Сегментный выбор ОС (N штук) */}
      <div className="mb-2.5 flex flex-wrap gap-1 rounded-lg border border-border bg-bg/40 p-1">
        {osList.map((os) => (
          <Seg key={os} osLabel={os} />
        ))}
      </div>

      {/* Питание живой ОС + Включить (WoL). «Включить» видна ВСЕГДА при заданном MAC
          (не прячется во время проверки); disabled только когда ПК подтверждённо online. */}
      <div className="flex flex-wrap gap-2">
        {d.mac && <Btn id="wake" label="Включить" icon={Zap} onClick={doWake} active={!!current} />}
        <Btn id="reboot" label="Ребут" icon={RotateCw} onClick={() => doPower('reboot', 'Ребут')} />
        <Btn id="suspend" label="Сон" icon={Moon} onClick={() => doPower('suspend', 'Сон')} />
        <Btn id="poweroff" label="Выключить" icon={Power} danger onClick={() => doPower('poweroff', 'Выключить')} />
        {failed && <Btn id="diag" label="Диагностика" icon={Stethoscope} onClick={doDiag} />}
      </div>
      {!hasWakePath(d) && <OneWayHint />}

      {msg && <div className="mt-2 whitespace-pre-wrap text-[11px] text-slate-500">{msg}</div>}
      {diag && (
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg/60 p-2 font-mono text-[11px] leading-relaxed text-slate-400">
          {diag}
        </pre>
      )}
      <p className="mt-1.5 text-[11px] text-slate-600">
        Клик по неактивной ОС — перезагрузка в неё.{d.mac ? ' «Включить» — Wake-on-LAN (будит из сна S3).' : ' Укажи MAC в карточке для WoL.'}
      </p>
    </div>
  )
}

function PowerSection({ device: d }: { device: DeviceDTO }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [diag, setDiag] = useState<string | null>(null)
  const online = d.status === 'online'

  // Питание идёт через main (pc.power → живая ОС): -i/inhibitors, двухфазный вердикт, реальный stderr.
  const doPower = async (action: 'reboot' | 'poweroff' | 'suspend', label: string): Promise<void> => {
    if (!api) return
    if (!window.confirm(confirmPowerText(d, action, label))) return
    setBusy(action)
    setMsg(null)
    setDiag(null)
    setFailed(false)
    const r = await api.pc.power(d.id, action)
    setBusy(null)
    setMsg(powerMsg(r))
    setFailed(powerFailed(r))
  }
  const doWake = async (): Promise<void> => {
    if (!api) return
    setBusy('wake')
    setMsg(null)
    setDiag(null)
    const r = await api.pc.wake(d.id)
    setBusy(null)
    setMsg(r.ok ? '✓ magic-пакет отправлен (WoL) — устройство должно проснуться' : `✖ ${r.error}`)
  }
  const doDiag = async (): Promise<void> => {
    if (!api) return
    setBusy('diag')
    setDiag(null)
    const r = await api.pc.powerDiag(d.id)
    setBusy(null)
    setDiag(r.text || '(нет данных)')
  }

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

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">Питание</div>
      <div className="flex flex-wrap gap-2">
        {/* «Включить»: WoL при заданном MAC (видна всегда, disabled когда уже online);
            иначе — ссылка на консоль хостера; иначе — disabled-подсказка. Честно, без фейка. */}
        {d.mac ? (
          <Btn id="wake" label="Включить" icon={Zap} onClick={doWake} active={online} />
        ) : d.consoleUrl ? (
          <a
            href={d.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-white/5"
          >
            <Zap className="h-3.5 w-3.5" /> Включить в панели ↗
          </a>
        ) : (
          <button
            disabled
            title="Укажи MAC (Wake-on-LAN в своей сети) или ссылку на консоль хостера"
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 opacity-50 ring-1 ring-border"
          >
            <Zap className="h-3.5 w-3.5" /> Включить
          </button>
        )}
        <Btn id="reboot" label="Ребут" icon={RotateCw} onClick={() => doPower('reboot', 'Ребут')} />
        <Btn id="suspend" label="Сон" icon={Moon} onClick={() => doPower('suspend', 'Сон')} />
        <Btn id="poweroff" label="Выключить" icon={Power} danger onClick={() => doPower('poweroff', 'Выключить')} />
        {failed && <Btn id="diag" label="Диагностика" icon={Stethoscope} onClick={doDiag} />}
      </div>
      {!hasWakePath(d) && <OneWayHint />}
      {msg && <div className="mt-2 whitespace-pre-wrap text-[11px] text-slate-500">{msg}</div>}
      {diag && (
        <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg/60 p-2 font-mono text-[11px] leading-relaxed text-slate-400">
          {diag}
        </pre>
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

/** Байт/с → человекочитаемо (МБ/с · КБ/с · Б/с). */
export function fmtBps(bps?: number | null): string {
  const b = bps ?? 0
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} МБ/с`
  if (b >= 1024) return `${Math.round(b / 1024)} КБ/с`
  return `${Math.round(b)} Б/с`
}

function Chip({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: typeof Gauge
  label: string
  value: string
  tone?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className={cn('ml-auto truncate text-xs font-medium tabular-nums', tone ?? 'text-slate-200')}>{value}</span>
    </div>
  )
}

// Компактный ряд метрик обзора (AIDA-минимум): Load, Сеть ↓/↑, Swap (если есть), Темп (если есть).
function MetricChips({ device: d }: { device: DeviceDTO }): React.JSX.Element | null {
  const hasLoad = d.load1 != null
  const hasNet = d.netRx != null || d.netTx != null
  const hasSwap = (d.swapTotal ?? 0) > 0
  const hasTemp = d.tempCpu != null
  if (!hasLoad && !hasNet && !hasSwap && !hasTemp) return null
  const tempTone =
    d.tempCpu == null ? undefined : d.tempCpu >= 80 ? 'text-rose-400' : d.tempCpu >= 60 ? 'text-amber-400' : 'text-emerald-400'
  return (
    <div className="grid grid-cols-2 gap-2">
      {hasLoad && <Chip icon={Gauge} label="Load" value={d.load1!.toFixed(2)} />}
      {hasNet && <Chip icon={ArrowDownUp} label="Сеть" value={`↓${fmtBps(d.netRx)} ↑${fmtBps(d.netTx)}`} />}
      {hasSwap && <Chip icon={Layers} label="Swap" value={`${d.swapUsed}/${d.swapTotal} GB`} />}
      {hasTemp && <Chip icon={Thermometer} label="Темп." value={`${d.tempCpu}°C`} tone={tempTone} />}
    </div>
  )
}

function Spec({ icon: Icon, label, value, sub }: { icon: typeof Cpu; label: string; value?: string; sub?: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <div className="truncate text-sm font-medium text-slate-200" title={value}>
        {value || '—'}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-[11px] text-slate-500" title={sub}>
          {sub}
        </div>
      )}
    </div>
  )
}

// Полноценная сводка комплектующих (agentless-инвентарь, кэш). Авто-сбор при первом открытии.
function HardwareSection({ device: d }: { device: DeviceDTO }): React.JSX.Element {
  const [hw, setHw] = useState<HardwareInfo | null>(null)
  const [collectedAt, setCollectedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return
    setLoading(true)
    setErr(null)
    const r = await api.hw.refresh(d.id)
    setLoading(false)
    if (r.ok && r.info) {
      setHw(r.info)
      setCollectedAt(r.info.collectedAt ?? Date.now())
    } else setErr(r.error ?? 'не удалось собрать сводку')
  }, [d.id])

  useEffect(() => {
    let alive = true
    if (!api) return
    void api.hw.get(d.id).then((c) => {
      if (!alive) return
      if (c) {
        setHw(c.info)
        setCollectedAt(c.collectedAt)
      } else void refresh() // авто-сбор, если кэша ещё нет
    })
    return () => {
      alive = false
    }
  }, [d.id, refresh])

  const when = collectedAt ? new Date(collectedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : null
  const mhz = hw?.cpuMhzMax ? `до ${(hw.cpuMhzMax / 1000).toFixed(1)} ГГц` : ''
  const cores = hw?.cpuCores ? `${hw.cpuCores}я${hw.cpuThreads ? `/${hw.cpuThreads}п` : ''}` : ''

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">Железо</span>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-50"
          title="Пересобрать сводку"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {when ? `собрано ${when}` : 'собрать'}
        </button>
      </div>
      {err && !hw ? (
        <p className="py-1 text-center text-xs text-slate-500">{err}</p>
      ) : !hw ? (
        <p className="py-2 text-center text-xs text-slate-600">{loading ? 'Собираю сводку…' : 'Нет данных.'}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Spec icon={Cpu} label="Процессор" value={hw.cpuModel} sub={[cores, mhz].filter(Boolean).join(' · ')} />
            <Spec icon={MemoryStick} label="Память" value={hw.ramGb ? `${hw.ramGb} GB` : undefined} sub={hw.dimms?.join(' · ')} />
            {hw.gpus && hw.gpus.length > 0 && (
              <Spec icon={MonitorCog} label="Графика" value={hw.gpus.join(', ')} sub={hw.gpuDriver ? `драйвер ${hw.gpuDriver}` : undefined} />
            )}
            {hw.board && <Spec icon={CircuitBoard} label="Плата" value={hw.board} />}
            <Spec icon={Server} label="Система" value={hw.os} sub={[hw.kernel, hw.virt].filter(Boolean).join(' · ')} />
          </div>
          {hw.disks && hw.disks.length > 0 && (
            <div className="mt-2 rounded-lg border border-border bg-card/50 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5 text-slate-500" />
                <span className="text-[11px] uppercase tracking-wide text-slate-500">Накопители</span>
              </div>
              <ul className="space-y-1">
                {hw.disks.map((disk) => (
                  <li key={disk.name} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-slate-300" title={disk.model || disk.name}>
                      {disk.model || disk.name}
                    </span>
                    <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">
                      {disk.ssd ? 'SSD' : 'HDD'}
                    </span>
                    <span className="w-20 shrink-0 text-right tabular-nums text-slate-400">
                      {disk.sizeGb >= 1000 ? `${(disk.sizeGb / 1000).toFixed(1)} TB` : `${disk.sizeGb} GB`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
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
        <img src={deviceIllustration(d.kind, d.role, d.icon)} alt="" className="mx-auto h-full object-contain py-3" draggable={false} />
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
            <Fact label={d.altOs.length ? 'Сейчас ОС' : 'OS'} value={d.runningOs || d.os} />
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

          <MetricChips device={d} />

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

          <HardwareSection device={d} />

          {d.altOs.length > 0 ? <DualBootSection device={d} /> : <PowerSection device={d} />}
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
