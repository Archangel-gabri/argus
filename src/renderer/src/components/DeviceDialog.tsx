import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { X, Loader2, Sparkles, Upload, Wand2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ILLUSTRATIONS, defaultIllustrationKey } from '@/lib/illustrations'
import { useUI } from '@/store/ui'
import { useDevices } from '@/store/devices'
import type { AuthType, Currency, Status, DeviceInput, DeviceKind } from '@/types'
import { CURRENCY_CODES } from '@/types'

const CURRENCIES: readonly Currency[] = CURRENCY_CODES
const KINDS: Array<{ id: DeviceKind; label: string }> = [
  { id: 'server', label: 'Сервер' },
  { id: 'pc', label: 'ПК' },
  { id: 'router', label: 'Роутер' },
  { id: 'other', label: 'Другое' }
]

// Канонический список ОС (без версий) — подсказки для поля OS; можно ввести своё.
const OS_LIST = [
  'Ubuntu', 'Debian', 'Arch Linux', 'Fedora', 'CentOS', 'Rocky Linux', 'AlmaLinux',
  'openSUSE', 'Alpine Linux', 'Kali Linux', 'Windows', 'Windows Server', 'macOS',
  'FreeBSD', 'Proxmox VE', 'TrueNAS', 'RouterOS', 'OpenWrt', 'Android', 'iOS', 'Other'
]
const inputCls =
  'w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30'
const api = typeof window !== 'undefined' ? window.api : undefined

// Похоже ли на ЗАВЕРШЁННЫЙ публичный адрес (полный IPv4 или домен). Приватные/Tailscale/CGNAT
// не гео-запрашиваем — бесполезно и утекает внутренняя топология третьей стороне (ipwho.is).
const ipLooksPublic = (s: string): boolean => {
  const v = s.trim()
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(v)) return false
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\.[a-z]{2,}$/i.test(v)
}

interface FormFields {
  name: string
  provider: string
  kind: DeviceKind
  ip: string
  port: string
  user: string
  os: string
  country: string
  flag: string
  status: Status
  amount: string
  currency: Currency
  consoleUrl: string
  authMethod: AuthType
  password: string
  privateKey: string
  passphrase: string
  jumpId: string
  // bootEntry — точная запись GRUB для boot-switch; в UI не показываем, но СОХРАНЯЕМ при правке
  // (иначе grub-reboot сваливается в нечёткий поиск по ключевому слову → не та ОС).
  altOs: Array<{ os: string; ip: string; user: string; bootEntry?: string; port?: number }>
  mac: string
  role: string
  notes: string
  /** Загрузочная запись основной ОС — ею переключение выбирает цель. */
  bootEntry: string
  /** Портрет: ключ встроенного изображения, data-URL своей картинки или '' = авто. */
  icon: string
}

const EMPTY: FormFields = {
  name: '', provider: '', kind: 'server', ip: '', port: '22', user: 'root', os: '', country: '', flag: '',
  status: 'unknown', amount: '', currency: 'USD', consoleUrl: '',
  authMethod: 'password', password: '', privateKey: '', passphrase: '', jumpId: '', altOs: [], mac: '',
  role: '', notes: '', bootEntry: '', icon: ''
}

/**
 * Поле формы. hint — короткое объяснение: кружок «?» в правом углу подписи, подсказка по
 * наведению. Без него половину полей приходилось угадывать (что такое jump-host, зачем MAC,
 * чем «роль» отличается от имени).
 */
function Field({
  label,
  hint,
  full,
  children
}: {
  label: string
  hint?: string
  full?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className={cn('block', full && 'col-span-2')}>
      <span className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
        {hint && (
          <span
            title={hint}
            aria-label={hint}
            className="flex h-4 w-4 cursor-help items-center justify-center rounded-full text-[10px] font-bold text-slate-500 ring-1 ring-border hover:text-slate-300 hover:ring-slate-500"
          >
            ?
          </span>
        )}
      </span>
      {children}
    </label>
  )
}

/** Ряд портретов: встроенные + своя картинка + «авто». */
function IconPicker({
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
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onPick('')}
        title="Авто — по типу и роли устройства"
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
          className="h-11 w-11 overflow-hidden rounded-lg ring-2 ring-accent"
          onClick={() => onPick(custom)}
        >
          <img src={custom} alt="своя" className="h-full w-full object-cover" />
        </button>
      )}
      <button
        type="button"
        onClick={async () => {
          const r = await api?.devices.pickIcon()
          if (r?.ok && r.dataUrl) onPick(r.dataUrl)
        }}
        className="h-11 rounded-lg px-3 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-white/5"
      >
        Своя картинка…
      </button>
    </div>
  )
}

export function DeviceDialog(): React.JSX.Element | null {
  const dialog = useUI((s) => s.dialog)
  const close = useUI((s) => s.closeDialog)
  const create = useDevices((s) => s.create)
  const update = useDevices((s) => s.update)
  const devices = useDevices((s) => s.devices)

  const [f, setF] = useState<FormFields>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeMsg, setProbeMsg] = useState<string | null>(null)
  const [assistText, setAssistText] = useState('')
  const [assisting, setAssisting] = useState(false)
  const [assistMsg, setAssistMsg] = useState<string | null>(null)
  const [geoing, setGeoing] = useState(false)
  const [geoMsg, setGeoMsg] = useState<string | null>(null)
  const keyFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setError(null)
    if (dialog.mode === 'edit') {
      const d = dialog.device
      setF({
        name: d.name, provider: d.provider, kind: d.kind, ip: d.ip, port: String(d.port), user: d.user, os: d.os,
        country: d.country, flag: d.flag, status: d.status,
        amount: d.cost.amount ? String(d.cost.amount) : '', currency: d.cost.currency,
        consoleUrl: d.consoleUrl, authMethod: d.authType,
        password: '', privateKey: '', passphrase: '', jumpId: d.jumpId ?? '',
        altOs: d.altOs.map((a) => ({ os: a.os, ip: a.ip, user: a.user, bootEntry: a.bootEntry, port: a.port })), mac: d.mac ?? '',
        role: d.role ?? '', notes: d.notes ?? '', bootEntry: d.bootEntry ?? '', icon: d.icon ?? ''
      })
    } else {
      // Закрыли диалог — стираем поля. Раньше набранные пароль/ключ оставались в состоянии
      // React до конца сессии.
      setF(EMPTY)
    }
  }, [dialog])

  const loadKeyFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const text = await file.text()
    setF((p) => ({ ...p, privateKey: text, authMethod: 'key' }))
  }

  // ИИ-заполнение: вставленный текст → локальная Ollama → мёржим непустые поля (превью, юзер правит).
  const assist = async (): Promise<void> => {
    if (!api || !assistText.trim()) return
    setAssisting(true)
    setAssistMsg(null)
    const r = await api.assist.parseDevice(assistText)
    setAssisting(false)
    if (!r.ok || !r.fields) {
      setAssistMsg(`✖ ${r.error ?? 'не удалось'}`)
      return
    }
    const x = r.fields
    setF((p) => ({
      ...p,
      name: x.name ?? p.name,
      provider: x.provider ?? p.provider,
      kind: x.kind ?? p.kind,
      ip: x.ip ?? p.ip,
      port: x.port != null ? String(x.port) : p.port,
      user: x.user ?? p.user,
      os: x.os ?? p.os,
      country: x.country ?? p.country,
      flag: x.flag ?? p.flag,
      consoleUrl: x.consoleUrl ?? p.consoleUrl,
      amount: x.cost?.amount != null ? String(x.cost.amount) : p.amount,
      currency: x.cost?.currency ?? p.currency
    }))
    const filled = Object.keys(x).length
    setAssistMsg(`✓ заполнено полей: ${filled}${r.model ? ` · ${r.model}` : ''} — проверь и поправь`)
  }

  if (dialog.mode === 'closed') return null
  const editing = dialog.mode === 'edit'

  const set =
    (k: keyof FormFields) =>
    (e: { target: { value: string } }): void =>
      setF((p) => ({ ...p, [k]: e.target.value }))

  // Авто-гео по IP (скриптом, не ИИ): страна+город, флаг, хостер. По кнопке — перезаписывает
  // пустые поля. Авто-по-blur срабатывает ТОЛЬКО при добавлении нового устройства с пустой
  // страной и завершённым публичным адресом (см. onBlur ниже) — чтобы не слать реальные IP
  // на ipwho.is при каждой правке уже заполненного устройства.
  const geo = async (fillEmptyOnly = false): Promise<void> => {
    if (!api || !f.ip.trim()) return
    setGeoing(true)
    setGeoMsg(null)
    const r = await api.net.ipLookup(f.ip.trim())
    setGeoing(false)
    if (!r.ok) {
      if (!fillEmptyOnly) setGeoMsg(`✖ ${r.error ?? 'не удалось'}`)
      return
    }
    const place = [r.country, r.city].filter(Boolean).join(' · ')
    setF((p) => ({
      ...p,
      country: fillEmptyOnly && p.country.trim() ? p.country : place || p.country,
      flag: fillEmptyOnly && p.flag.trim() ? p.flag : r.flag || p.flag,
      provider: p.provider.trim() ? p.provider : r.provider ?? p.provider
    }))
    setGeoMsg(`✓ ${r.flag ?? ''} ${place}${r.provider ? ` · ${r.provider}` : ''}${r.asn ? ` · ${r.asn}` : ''}`)
  }

  const probe = async (): Promise<void> => {
    if (!api) return
    setProbing(true)
    setProbeMsg(null)
    const r = await api.ssh.probeHost({
      host: f.ip.trim(),
      port: parseInt(f.port, 10) || 22,
      user: f.user.trim() || 'root',
      password: f.authMethod === 'password' ? f.password : '',
      privateKey: f.authMethod === 'key' ? f.privateKey || undefined : undefined,
      passphrase: f.authMethod === 'key' ? f.passphrase || undefined : undefined
    })
    setProbing(false)
    if (r.ok) {
      setF((p) => ({ ...p, os: r.os || p.os, name: p.name || r.hostname || p.name, status: 'online' }))
      setProbeMsg(`✓ ${r.os ?? 'ok'} · ${r.cores ?? '?'} ядер · ${r.ramTotal ?? '?'} ГБ RAM`)
    } else {
      setProbeMsg(`✖ ${r.error ?? 'не удалось'}`)
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!f.name.trim()) {
      setError('Укажи имя устройства')
      return
    }
    setBusy(true)
    setError(null)
    const input: DeviceInput = {
      name: f.name.trim(),
      provider: f.provider.trim() || 'Custom',
      kind: f.kind,
      ip: f.ip.trim(),
      port: parseInt(f.port, 10) || 22,
      user: f.user.trim() || 'root',
      os: f.os.trim(),
      country: f.country.trim(),
      flag: f.flag.trim(),
      status: f.status,
      cost: { amount: parseFloat(f.amount) || 0, currency: f.currency, usd: 0 },
      consoleUrl: f.consoleUrl.trim(),
      // 'none' сохраняем как есть: раньше открыть и сохранить устройство без учётки было
      // достаточно, чтобы оно объявило себя парольным — с пустым паролем.
      authType: f.authMethod,
      // Blank on edit = keep the stored secret; only send what belongs to the chosen method.
      password: f.authMethod === 'password' ? (f.password ? f.password : null) : undefined,
      privateKey: f.authMethod === 'key' ? (f.privateKey ? f.privateKey : undefined) : undefined,
      passphrase: f.authMethod === 'key' ? (f.passphrase ? f.passphrase : undefined) : undefined,
      jumpId: f.jumpId || null,
      // Требуем и имя ОС, и адрес: безымянная ОС ломает подсветку «текущей» и уводит
      // boot-switch в нечёткий grub-поиск (может загрузить не ту ОС).
      altOs: f.altOs
        .filter((a) => a.ip.trim() && a.os.trim())
        .map((a) => ({
          os: a.os.trim(),
          ip: a.ip.trim(),
          user: a.user.trim() || 'root',
          ...(a.bootEntry ? { bootEntry: a.bootEntry } : {}),
          ...(a.port ? { port: a.port } : {})
        })),
      mac: f.mac.trim() || null,
      role: f.role.trim() || null,
      notes: f.notes.trim() || null,
      bootEntry: f.bootEntry.trim() || null,
      icon: f.icon || null
    }
    const r = dialog.mode === 'edit' ? await update(dialog.device.id, input) : await create(input)
    setBusy(false)
    if (r.ok) close()
    else setError(r.error ?? 'Failed to save')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={close}>
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-white">{editing ? 'Правка устройства' : 'Новое устройство'}</h2>
          <button
            onClick={close}
            className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {api && !editing && (
            <div className="mb-4 rounded-lg border border-accent/20 bg-accent/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-accent">
                <Wand2 className="h-3.5 w-3.5" /> Заполнить по тексту (локальный ИИ)
              </div>
              <textarea
                value={assistText}
                onChange={(e) => setAssistText(e.target.value)}
                placeholder="ssh user@host -p 2222, конфиг, письмо хостера — разберётся в поля"
                className={cn(inputCls, 'h-16 resize-y text-xs')}
                spellCheck={false}
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={assist}
                  disabled={assisting || !assistText.trim()}
                  className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-bg hover:bg-accent-hover disabled:opacity-50"
                >
                  {assisting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                  Заполнить
                </button>
                {assistMsg && <span className="text-xs text-slate-500">{assistMsg}</span>}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-600">
                Разбор идёт локально, текст никуда не отправляется.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Имя" full hint="Как устройство будет называться в списке. Только для тебя — на подключение не влияет.">
              <input className={inputCls} value={f.name} onChange={set('name')} placeholder="HubVPN · Tokyo" autoFocus />
            </Field>
            <Field label="Хостер / владелец" hint="Кто предоставляет машину: Hetzner, OVH, «Дома». Используется для логотипа и группировки расходов.">
              <input className={inputCls} value={f.provider} onChange={set('provider')} placeholder="Hetzner" />
            </Field>
            <Field label="Тип" hint="Сервер и компьютер получают полный набор: терминал, файлы, порты, метрики, экран. Роутер — только терминал.">
              <select
                className={inputCls}
                value={f.kind}
                onChange={(e) => setF((p) => ({ ...p, kind: e.target.value as DeviceKind }))}
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Портрет" full hint="Картинка на карточке. «Авто» — по типу и роли; можно выбрать из готовых или загрузить свою.">
              <IconPicker
                value={f.icon}
                kind={f.kind}
                role={f.role}
                onPick={(v) => setF((p) => ({ ...p, icon: v }))}
              />
            </Field>
            <Field label="Роль" hint="Назначение машины: master, cascade, exit, app, db. Показывается на карточке и подбирает картинку в режиме «авто».">
              <input className={inputCls} value={f.role} onChange={set('role')} placeholder="app · cockpit" />
            </Field>
            <Field label="Загрузочная запись" hint="Нужна только машинам с несколькими ОС, чтобы переключение выбирало нужную. Linux: номер EFI-записи (efibootmgr) либо пункт меню GRUB. Windows: идентификатор вида {xxxxxxxx-…} из bcdedit /enum firmware.">
              <input className={inputCls} value={f.bootEntry} onChange={set('bootEntry')} placeholder="0002" />
            </Field>
            <Field label="Адрес" hint="IP или имя хоста для SSH. Можно адрес в Tailscale (100.x) — так надёжнее, чем публичный IP.">
              <input
                className={inputCls}
                value={f.ip}
                onChange={set('ip')}
                onBlur={() => {
                  if (!editing && !f.country.trim() && ipLooksPublic(f.ip)) void geo(true)
                }}
                placeholder="203.0.113.10"
              />
            </Field>
            <Field label="Порт" hint="Порт SSH. По умолчанию 22.">
              <input className={inputCls} value={f.port} onChange={set('port')} inputMode="numeric" />
            </Field>
            <Field label="Пользователь SSH" hint="Под какой учётной записью подключаться: root, ubuntu, admin.">
              <input className={inputCls} value={f.user} onChange={set('user')} placeholder="root" />
            </Field>
            <Field label="Операционная система" hint="Влияет на то, какие команды шлются: у Windows и Linux они разные. Можно определить кнопкой «Определить по SSH».">
              <input className={inputCls} value={f.os} onChange={set('os')} placeholder="Ubuntu" list="os-list" />
              <datalist id="os-list">
                {OS_LIST.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </Field>
            <Field label="Страна" hint="Заполняется автоматически по IP кнопкой «Гео по IP».">
              <input className={inputCls} value={f.country} onChange={set('country')} placeholder="Japan" />
            </Field>
            <Field label="Флаг" hint="Эмодзи-флаг для карточки. Подставляется вместе со страной.">
              <input className={inputCls} value={f.flag} onChange={set('flag')} placeholder="🇯🇵" />
            </Field>
            <Field label="Стоимость в месяц" hint="Идёт в общий счёт расходов на разделе «Финансы». Ноль — если платить не нужно.">
              <input className={inputCls} value={f.amount} onChange={set('amount')} inputMode="decimal" placeholder="5" />
            </Field>
            <Field label="Валюта" hint="Для общего счёта суммы приводятся к долларам по приблизительному курсу.">
              <select className={inputCls} value={f.currency} onChange={set('currency')}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Панель управления хостера" full hint="Ссылка на панель, где машину можно включить или пересоздать. Открывается кнопкой на карточке — пригодится, когда SSH недоступен.">
              <input className={inputCls} value={f.consoleUrl} onChange={set('consoleUrl')} placeholder="https://…" />
            </Field>
            <Field label="Промежуточный хост (бастион)" full hint="Если машина доступна только через другой сервер — выбери его здесь. Подключение пойдёт туннелем через него.">
              <select className={inputCls} value={f.jumpId} onChange={set('jumpId')}>
                <option value="">— нет —</option>
                {devices
                  .filter((d) => dialog.mode !== 'edit' || d.id !== dialog.device.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </Field>
            {f.kind === 'pc' && (
              <Field label="MAC-адрес" full hint="Нужен, чтобы будить машину по сети (Wake-on-LAN). Работает только внутри своей локальной сети — до VPS не доедет.">
                <input className={inputCls} value={f.mac} onChange={set('mac')} placeholder="18:C0:4D:89:ED:6F" />
              </Field>
            )}
            {(f.kind === 'pc' || f.kind === 'server') && (
              <Field label="Другие системы на этой машине" full hint="Для машин с несколькими ОС. Ключ берётся тот же, что у основной; порт — тоже, если не указать свой. Приложение само определит, какая система сейчас запущена.">
                <div className="space-y-2">
                  {f.altOs.map((a, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        className={cn(inputCls, 'flex-1')}
                        value={a.os}
                        list="os-list"
                        placeholder="Windows 11"
                        onChange={(e) =>
                          setF((p) => ({ ...p, altOs: p.altOs.map((x, j) => (j === i ? { ...x, os: e.target.value } : x)) }))
                        }
                      />
                      <input
                        className={cn(inputCls, 'w-32')}
                        value={a.ip}
                        placeholder="IP/host"
                        onChange={(e) =>
                          setF((p) => ({ ...p, altOs: p.altOs.map((x, j) => (j === i ? { ...x, ip: e.target.value } : x)) }))
                        }
                      />
                      <input
                        className={cn(inputCls, 'w-24')}
                        value={a.user}
                        placeholder="user"
                        onChange={(e) =>
                          setF((p) => ({ ...p, altOs: p.altOs.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)) }))
                        }
                      />
                      {/* Своя служба SSH на Windows настраивается отдельно от Linux и совпадать
                          по порту не обязана. Пусто — берётся порт основной записи. */}
                      <input
                        className={cn(inputCls, 'w-16')}
                        value={a.port ?? ''}
                        inputMode="numeric"
                        placeholder="порт"
                        title="Порт SSH этой системы. Пусто — как у основной."
                        onChange={(e) =>
                          setF((p) => ({
                            ...p,
                            altOs: p.altOs.map((x, j) =>
                              j === i ? { ...x, port: Number(e.target.value.replace(/\D/g, '')) || undefined } : x
                            )
                          }))
                        }
                      />
                      <button
                        type="button"
                        onClick={() => setF((p) => ({ ...p, altOs: p.altOs.filter((_, j) => j !== i) }))}
                        className="shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
                        aria-label="Удалить ОС"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setF((p) => ({ ...p, altOs: [...p.altOs, { os: '', ip: '', user: 'root' }] }))}
                    className="inline-flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-card-hover"
                  >
                    + добавить ОС
                  </button>
                  <p className="text-[11px] text-slate-600">
                    Для dual/triple-boot: каждая ОС на своём адресе (напр. Tailscale), тот же SSH-ключ. На карточке — переключатель.
                  </p>
                </div>
              </Field>
            )}
            <Field label="Заметки" full hint="Свободный текст: что на машине крутится, к чему подключена, что не забыть. Виден на карточке.">
              <textarea
                className={cn(inputCls, 'h-16 resize-y')}
                value={f.notes}
                onChange={set('notes')}
                placeholder="Что здесь работает, особенности, чего не трогать"
              />
            </Field>
            <Field label="Способ входа" full hint="Пароль или приватный ключ. Всё хранится в зашифрованном виде и наружу не уходит.">
              <div className="flex gap-1 rounded-lg border border-border bg-bg/60 p-1">
                {(['password', 'key'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setF((p) => ({ ...p, authMethod: m }))}
                    className={cn(
                      'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                      f.authMethod === m ? 'bg-accent text-bg' : 'text-slate-400 hover:text-slate-200'
                    )}
                  >
                    {m === 'password' ? 'Пароль' : 'SSH-ключ'}
                  </button>
                ))}
              </div>
            </Field>

            {f.authMethod === 'password' ? (
              <Field
                label={editing ? 'Пароль SSH (пусто = оставить текущий)' : 'Пароль SSH'}
                full
                hint="Хранится в зашифрованном виде и в интерфейс обратно не возвращается. При правке пустое поле означает «не менять»."
              >
                <input
                  className={inputCls}
                  type="password"
                  value={f.password}
                  onChange={set('password')}
                  placeholder="хранится в зашифрованном виде"
                />
              </Field>
            ) : (
              <>
                <Field label={editing ? 'Приватный ключ (пусто = оставить текущий)' : 'Приватный ключ (PEM / OpenSSH)'} full>
                  <textarea
                    className={cn(inputCls, 'h-24 resize-y font-mono text-[11px] leading-tight')}
                    value={f.privateKey}
                    onChange={set('privateKey')}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => keyFileRef.current?.click()}
                    className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-card-hover"
                  >
                    <Upload className="h-3 w-3" /> Загрузить из файла
                  </button>
                  <input
                    ref={keyFileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => void loadKeyFile(e.target.files?.[0])}
                  />
                </Field>
                <Field label="Passphrase ключа (если есть)" full>
                  <input
                    className={inputCls}
                    type="password"
                    value={f.passphrase}
                    onChange={set('passphrase')}
                    placeholder="optional"
                  />
                </Field>
              </>
            )}
          </div>

          {api && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={probe}
                disabled={
                  probing ||
                  !f.ip.trim() ||
                  // При правке секрет уже лежит в хранилище, поля пустые намеренно — раньше из-за
                  // этого кнопка была мертва ровно там, где она нужнее всего.
                  (!editing && (f.authMethod === 'password' ? !f.password : !f.privateKey))
                }
                className="flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-card-hover disabled:opacity-50"
              >
                {probing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                )}
                Определить по SSH
              </button>
              <button
                type="button"
                onClick={() => void geo(false)}
                disabled={geoing || !f.ip.trim()}
                className="flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-card-hover disabled:opacity-50"
              >
                {geoing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-accent" />}
                Гео по IP
              </button>
              {probeMsg && <span className="text-xs text-slate-500">{probeMsg}</span>}
              {geoMsg && <span className="text-xs text-slate-500">{geoMsg}</span>}
            </div>
          )}
          {error && <div className="mt-3 text-xs text-rose-400">{error}</div>}

          <div className="mt-5 flex items-center justify-between">
            <span className="text-[11px] text-slate-600">Пароли и ключи хранятся в зашифрованном виде.</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg hover:bg-accent-hover disabled:opacity-60"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? 'Сохранить' : 'Добавить'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
