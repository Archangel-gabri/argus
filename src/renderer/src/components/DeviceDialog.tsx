import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { X, Loader2, Sparkles, Upload, Wand2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Hint } from '@/components/ui/Hint'
import { ILLUSTRATIONS, defaultIllustrationKey } from '@/lib/illustrations'
import { useUI } from '@/store/ui'
import { useDevices } from '@/store/devices'
import type { AuthType, Currency, Status, DeviceInput, DeviceKind } from '@/types'
import { CURRENCY_CODES } from '@/types'
import { shouldDismissOverlay, useOverlayA11y } from '@/lib/overlay'
import {
  assignBootEntry,
  selectedBootEntry,
  probesWithStoredSecret,
  type BootTarget
} from '@/lib/device-dialog-policy'

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
  const labelId = useId()
  const childList = Children.toArray(children)
  const child = childList.length === 1 ? childList[0] : null
  const isNativeControl =
    isValidElement(child) &&
    typeof child.type === 'string' &&
    (child.type === 'input' || child.type === 'select' || child.type === 'textarea')
  const content = isNativeControl
    ? cloneElement(child as ReactElement<{ 'aria-labelledby'?: string }>, { 'aria-labelledby': labelId })
    : (
        <div role="group" aria-labelledby={labelId}>
          {children}
        </div>
      )

  return (
    <div className={cn('block', full && 'col-span-2')}>
      <span className="mb-1 flex items-center justify-between gap-2">
        <span id={labelId} className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {label}
        </span>
        {/* Подсказка через свой компонент, а не через атрибут `title`: тот рисуется системой
            мимо палитры, появляется с задержкой около секунды и не открывается с клавиатуры. */}
        {hint && <Hint side="left" label={`Подсказка: ${label}`}>{hint}</Hint>}
      </span>
      {content}
    </div>
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
  // Загрузочные записи, прочитанные с самой машины. null — ещё не спрашивали.
  const [bootList, setBootList] = useState<Array<{ id: string; label: string }> | null>(null)
  const [bootMsg, setBootMsg] = useState<string | null>(null)
  const [bootBusy, setBootBusy] = useState(false)
  const [bootTarget, setBootTarget] = useState<BootTarget>('primary')
  const [assistText, setAssistText] = useState('')
  const [assisting, setAssisting] = useState(false)
  const [assistMsg, setAssistMsg] = useState<string | null>(null)
  const [geoing, setGeoing] = useState(false)
  const [geoMsg, setGeoMsg] = useState<string | null>(null)
  const keyFileRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const baselineRef = useRef(JSON.stringify(EMPTY))
  // Любой ответ, начатый в диалоге A, становится недействительным после перехода к B/close.
  const generationRef = useRef(0)

  useOverlayA11y({
    open: dialog.mode !== 'closed',
    onEscape: close,
    containerRef: dialogRef,
    initialFocusRef: nameRef
  })

  useEffect(() => {
    generationRef.current += 1
    setError(null)
    setBusy(false)
    setProbing(false)
    setBootBusy(false)
    setAssisting(false)
    setGeoing(false)
    setProbeMsg(null)
    setBootList(null)
    setBootMsg(null)
    setBootTarget('primary')
    setAssistText('')
    setAssistMsg(null)
    setGeoMsg(null)
    if (dialog.mode === 'edit') {
      const d = dialog.device
      const next: FormFields = {
        name: d.name, provider: d.provider, kind: d.kind, ip: d.ip, port: String(d.port), user: d.user, os: d.os,
        country: d.country, flag: d.flag, status: d.status,
        amount: d.cost.amount ? String(d.cost.amount) : '', currency: d.cost.currency,
        consoleUrl: d.consoleUrl, authMethod: d.authType,
        password: '', privateKey: '', passphrase: '', jumpId: d.jumpId ?? '',
        altOs: d.altOs.map((a) => ({ os: a.os, ip: a.ip, user: a.user, bootEntry: a.bootEntry, port: a.port })), mac: d.mac ?? '',
        role: d.role ?? '', notes: d.notes ?? '', bootEntry: d.bootEntry ?? '', icon: d.icon ?? ''
      }
      baselineRef.current = JSON.stringify(next)
      setF(next)
    } else {
      // Закрыли диалог — стираем поля. Раньше набранные пароль/ключ оставались в состоянии
      // React до конца сессии.
      baselineRef.current = JSON.stringify(EMPTY)
      setF(EMPTY)
    }
  }, [dialog])

  const loadKeyFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    const generation = generationRef.current
    try {
      const text = await file.text()
      if (generation === generationRef.current)
        setF((p) => ({ ...p, privateKey: text, authMethod: 'key' }))
    } catch (cause) {
      if (generation === generationRef.current)
        setError(cause instanceof Error ? cause.message : 'Не удалось прочитать файл ключа')
    }
  }

  // ИИ-заполнение: вставленный текст → локальная Ollama → мёржим непустые поля (превью, юзер правит).
  const assist = async (): Promise<void> => {
    if (!api || !assistText.trim()) return
    const generation = generationRef.current
    setAssisting(true)
    setAssistMsg(null)
    try {
      const r = await api.assist.parseDevice(assistText)
      if (generation !== generationRef.current) return
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
    } catch (cause) {
      if (generation === generationRef.current)
        setAssistMsg(`✖ ${cause instanceof Error ? cause.message : 'не удалось разобрать текст'}`)
    } finally {
      if (generation === generationRef.current) setAssisting(false)
    }
  }

  if (dialog.mode === 'closed') return null
  const editing = dialog.mode === 'edit'
  const dirty = JSON.stringify(f) !== baselineRef.current || assistText.trim().length > 0

  const set =
    (k: keyof FormFields) =>
    (e: { target: { value: string } }): void =>
      setF((p) => ({ ...p, [k]: e.target.value }))

  // Гео у внешнего ipwho.is запрашивается только по явной кнопке пользователя: IP — часть
  // приватной топологии, поэтому blur/открытие диалога не имеют права отправлять его наружу.
  const geo = async (): Promise<void> => {
    if (!api || !f.ip.trim()) return
    const generation = generationRef.current
    setGeoing(true)
    setGeoMsg(null)
    try {
      const r = await api.net.ipLookup(f.ip.trim())
      if (generation !== generationRef.current) return
      if (!r.ok) {
        setGeoMsg(`✖ ${r.error ?? 'не удалось'}`)
        return
      }
      const place = [r.country, r.city].filter(Boolean).join(' · ')
      setF((p) => ({
        ...p,
        country: place || p.country,
        flag: r.flag || p.flag,
        provider: p.provider.trim() ? p.provider : r.provider ?? p.provider
      }))
      setGeoMsg(`✓ ${r.flag ?? ''} ${place}${r.provider ? ` · ${r.provider}` : ''}${r.asn ? ` · ${r.asn}` : ''}`)
    } catch (cause) {
      if (generation === generationRef.current)
        setGeoMsg(`✖ ${cause instanceof Error ? cause.message : 'гео-сервис не ответил'}`)
    } finally {
      if (generation === generationRef.current) setGeoing(false)
    }
  }

  const probe = async (): Promise<void> => {
    if (!api) return
    const generation = generationRef.current
    setProbing(true)
    setProbeMsg(null)
    try {
      if (
        dialog.mode === 'edit' &&
        f.authMethod === dialog.device.authType &&
        probesWithStoredSecret(true, dialog.device.hasSecret, f.password, f.privateKey)
      ) {
        const endpointUnchanged =
          f.ip.trim() === dialog.device.ip &&
          (parseInt(f.port, 10) || 22) === dialog.device.port &&
          (f.user.trim() || 'root') === dialog.device.user &&
          (f.jumpId || null) === dialog.device.jumpId
        if (!endpointUnchanged) {
          setProbeMsg('✖ адрес или маршрут изменён: сначала сохрани, затем Argus проверит его старым секретом')
          return
        }
        // Секрет остаётся в main: renderer передаёт только id уже сохранённой записи.
        const r = await api.pc.metrics(dialog.device.id)
        if (generation !== generationRef.current) return
        useDevices.getState().updateMetrics(dialog.device.id, r)
        if (r.status !== 'online') {
          setProbeMsg(
            r.status === 'unknown'
              ? '✖ один опрос не дал ответа — состояние неизвестно'
              : '✖ хост не ответил на два опроса подряд'
          )
          return
        }
        setF((p) => ({ ...p, os: r.current || p.os, status: 'online' }))
        setProbeMsg(`✓ ${r.current || 'хост отвечает'} · CPU ${r.cpu ?? '—'}% · RAM ${r.ramTotal ?? '—'} ГБ`)
        return
      }

      const r = await api.ssh.probeHost({
        host: f.ip.trim(),
        port: parseInt(f.port, 10) || 22,
        user: f.user.trim() || 'root',
        password: f.authMethod === 'password' ? f.password : '',
        privateKey: f.authMethod === 'key' ? f.privateKey || undefined : undefined,
        passphrase: f.authMethod === 'key' ? f.passphrase || undefined : undefined
      })
      if (generation !== generationRef.current) return
      if (r.ok) {
        setF((p) => ({ ...p, os: r.os || p.os, name: p.name || r.hostname || p.name, status: 'online' }))
        setProbeMsg(`✓ ${r.os ?? 'ok'} · ${r.cores ?? '?'} ядер · ${r.ramTotal ?? '?'} ГБ RAM`)
      } else {
        setProbeMsg(`✖ ${r.error ?? 'не удалось'}`)
      }
    } catch (cause) {
      if (generation === generationRef.current)
        setProbeMsg(`✖ ${cause instanceof Error ? cause.message : 'SSH-проверка не завершилась'}`)
    } finally {
      if (generation === generationRef.current) setProbing(false)
    }
  }

  // Спросить машину, какие у неё загрузочные записи. Это то, ради чего всё затевалось:
  // без записи переключение ОС не выбирает систему, а узнать её можно было только руками
  // через bcdedit/efibootmgr — и человек просто не знал, что вписывать.
  const loadBootEntries = async (): Promise<void> => {
    // Спрашивать можно только у уже заведённого устройства: у нового ещё нет записи в хранилище,
    // а значит и адреса, по которому идти.
    if (!api || dialog.mode !== 'edit') return
    const generation = generationRef.current
    setBootBusy(true)
    setBootMsg(null)
    setBootList(null)
    try {
      const r = await api.pc.bootEntries(dialog.device.id)
      if (generation !== generationRef.current) return
      if (!r.ok) {
        setBootMsg(`✖ ${r.error ?? 'не удалось прочитать'}`)
        return
      }
      setBootList(r.entries)
      setBootMsg(r.entries.length ? `найдено записей: ${r.entries.length} (прочитано в ${r.os})` : 'записей не найдено')
    } catch (cause) {
      if (generation === generationRef.current)
        setBootMsg(`✖ ${cause instanceof Error ? cause.message : 'не удалось прочитать записи'}`)
    } finally {
      if (generation === generationRef.current) setBootBusy(false)
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!f.name.trim()) {
      setError('Укажи имя устройства')
      return
    }
    const generation = generationRef.current
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
    try {
      const r = dialog.mode === 'edit' ? await update(dialog.device.id, input) : await create(input)
      if (generation !== generationRef.current) return
      if (r.ok) close()
      else setError(r.error ?? 'Не удалось сохранить')
    } catch (cause) {
      if (generation === generationRef.current)
        setError(cause instanceof Error ? cause.message : 'Не удалось сохранить')
    } finally {
      if (generation === generationRef.current) setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && shouldDismissOverlay('backdrop', dirty)) close()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-dialog-title"
        className="w-full max-w-lg rounded-2xl border border-border bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="device-dialog-title" className="text-base font-semibold text-white">
            {editing ? 'Правка устройства' : 'Новое устройство'}
          </h2>
          <button
            onClick={close}
            className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={submit} className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {api && !editing && (
            <div className="mb-4 rounded-lg border border-accent/20 bg-accent/5 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-accent">
                <Wand2 className="h-3.5 w-3.5" /> Заполнить по тексту (локальный ИИ)
                {/* Было постоянным абзацем под полем. Знать это нужно один раз, а занимало
                    место всегда — поэтому под «?». */}
                <Hint>Разбор идёт локально, текст никуда не уходит.</Hint>
              </div>
              <textarea
                aria-label="Текст для локального заполнения"
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
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Имя" full hint="Как называть в списке.">
              <input ref={nameRef} className={inputCls} value={f.name} onChange={set('name')} placeholder="HubVPN · Tokyo" />
            </Field>
            <Field label="Хостер / владелец" hint="Для логотипа и группировки расходов.">
              <input className={inputCls} value={f.provider} onChange={set('provider')} placeholder="Hetzner" />
            </Field>
            <Field label="Тип" hint="Роутеру доступен только терминал.">
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
            <Field label="Портрет" full hint="«Авто» — по типу и роли.">
              <IconPicker
                value={f.icon}
                kind={f.kind}
                role={f.role}
                onPick={(v) => setF((p) => ({ ...p, icon: v }))}
              />
            </Field>
            <Field label="Роль" hint="Назначение: master, cascade, exit, app.">
              <input className={inputCls} value={f.role} onChange={set('role')} placeholder="app · cockpit" />
            </Field>
            <Field
              label="Загрузочная запись"
              full
              hint="Нажми «Спросить машину» — Argus прочитает список сам. Вручную: Linux — номер EFI-записи (efibootmgr), Windows — идентификатор вида {xxxxxxxx-…} из bcdedit /enum firmware."
            >
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Загрузочная запись"
                    className={cn(inputCls, 'flex-1')}
                    value={f.bootEntry}
                    onChange={set('bootEntry')}
                    placeholder="0002"
                  />
                  {editing && (
                    <button
                      type="button"
                      onClick={() => void loadBootEntries()}
                      disabled={bootBusy}
                      className="shrink-0 rounded-md bg-card px-2.5 py-1.5 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
                    >
                      {bootBusy ? 'читаю…' : 'Спросить машину'}
                    </button>
                  )}
                </div>
                {bootMsg && <p className="text-[11px] text-slate-500">{bootMsg}</p>}
                {bootList && bootList.length > 0 && (
                  <div className="space-y-1 rounded-md border border-border bg-bg/40 p-1.5">
                    <label className="mb-1 flex items-center gap-2 px-1 text-[11px] text-slate-400">
                      <span className="shrink-0">Назначить для</span>
                      <select
                        aria-label="Целевая ОС для загрузочной записи"
                        value={bootTarget}
                        onChange={(event) => setBootTarget(event.target.value as BootTarget)}
                        className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-slate-200"
                      >
                        <option value="primary">{f.os || 'основная ОС'}</option>
                        {f.altOs.map((os, index) => (
                          <option key={index} value={`alt:${index}`}>
                            {os.os || `ОС ${index + 2}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    {bootList.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setF((p) => assignBootEntry(p, bootTarget, b.id))}
                        aria-pressed={selectedBootEntry(f, bootTarget) === b.id}
                        className={cn(
                          'block w-full rounded px-2 py-1 text-left text-[11px] leading-snug hover:bg-white/5',
                          selectedBootEntry(f, bootTarget) === b.id ? 'text-accent' : 'text-slate-300'
                        )}
                        title={`${b.id} — ${b.label}`}
                      >
                        {/* Без обрезки: обрезался ровно путь загрузчика, а он тут единственное,
                            по чему записи вообще можно различить. */}
                        <span className="block break-all">{b.label}</span>
                        <span className="block break-all font-mono text-[10px] text-slate-600">{b.id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Field>
            <Field label="Адрес" hint="IP или хост для SSH. Годится адрес Tailscale.">
              <input
                className={inputCls}
                value={f.ip}
                onChange={set('ip')}
                placeholder="203.0.113.10"
              />
            </Field>
            <Field label="Порт" hint="Порт SSH. По умолчанию 22.">
              <input className={inputCls} value={f.port} onChange={set('port')} inputMode="numeric" />
            </Field>
            <Field label="Пользователь SSH" hint="Учётная запись SSH: root, ubuntu.">
              <input className={inputCls} value={f.user} onChange={set('user')} placeholder="root" />
            </Field>
            <Field label="Операционная система" hint="Влияет на команды. Можно определить по SSH.">
              <input className={inputCls} value={f.os} onChange={set('os')} placeholder="Ubuntu" list="os-list" />
              <datalist id="os-list">
                {OS_LIST.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            </Field>
            <Field label="Страна" hint="Заполняется кнопкой «Гео по IP».">
              <input className={inputCls} value={f.country} onChange={set('country')} placeholder="Japan" />
            </Field>
            <Field label="Флаг" hint="Эмодзи-флаг для карточки.">
              <input className={inputCls} value={f.flag} onChange={set('flag')} placeholder="🇯🇵" />
            </Field>
            <Field label="Стоимость в месяц" hint="Идёт в общий счёт расходов.">
              <input className={inputCls} value={f.amount} onChange={set('amount')} inputMode="decimal" placeholder="5" />
            </Field>
            <Field label="Валюта" hint="Для итога приводится к долларам.">
              <select className={inputCls} value={f.currency} onChange={set('currency')}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Панель управления хостера" full hint="Включить машину, когда SSH недоступен.">
              <input className={inputCls} value={f.consoleUrl} onChange={set('consoleUrl')} placeholder="https://…" />
            </Field>
            <Field label="Промежуточный хост (бастион)" full hint="Если машина доступна только через другой сервер.">
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
                    <div key={i} className="space-y-2 rounded-lg border border-border/70 bg-bg/30 p-2">
                      <div className="flex items-center gap-2">
                        <input
                          aria-label={`ОС ${i + 2}`}
                          className={cn(inputCls, 'flex-1')}
                          value={a.os}
                          list="os-list"
                          placeholder="Windows 11"
                          onChange={(e) =>
                            setF((p) => ({
                              ...p,
                              altOs: p.altOs.map((x, j) => (j === i ? { ...x, os: e.target.value } : x))
                            }))
                          }
                        />
                        <input
                          aria-label={`Адрес ОС ${i + 2}`}
                          className={cn(inputCls, 'w-32')}
                          value={a.ip}
                          placeholder="IP/host"
                          onChange={(e) =>
                            setF((p) => ({
                              ...p,
                              altOs: p.altOs.map((x, j) => (j === i ? { ...x, ip: e.target.value } : x))
                            }))
                          }
                        />
                        <input
                          aria-label={`Пользователь ОС ${i + 2}`}
                          className={cn(inputCls, 'w-24')}
                          value={a.user}
                          placeholder="user"
                          onChange={(e) =>
                            setF((p) => ({
                              ...p,
                              altOs: p.altOs.map((x, j) => (j === i ? { ...x, user: e.target.value } : x))
                            }))
                          }
                        />
                        {/* Своя служба SSH на Windows настраивается отдельно от Linux и совпадать
                            по порту не обязана. Пусто — берётся порт основной записи. */}
                        <input
                          aria-label={`Порт SSH для ОС ${i + 2}`}
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
                          onClick={() => {
                            setBootTarget('primary')
                            setF((p) => ({ ...p, altOs: p.altOs.filter((_, j) => j !== i) }))
                          }}
                          className="shrink-0 rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400"
                          aria-label="Удалить ОС"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <input
                        aria-label={`Загрузочная запись для ОС ${i + 2}`}
                        className={inputCls}
                        value={a.bootEntry ?? ''}
                        placeholder="EFI/GRUB-запись этой ОС (выбери из списка выше)"
                        onChange={(event) =>
                          setF((p) => ({
                            ...p,
                            altOs: p.altOs.map((x, j) =>
                              j === i ? { ...x, bootEntry: event.target.value } : x
                            )
                          }))
                        }
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setF((p) => ({ ...p, altOs: [...p.altOs, { os: '', ip: '', user: 'root' }] }))}
                    className="inline-flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-card-hover"
                  >
                    + добавить ОС
                  </button>
                </div>
              </Field>
            )}
            <Field label="Заметки" full hint="Свободный текст. Виден на карточке.">
              <textarea
                className={cn(inputCls, 'h-16 resize-y')}
                value={f.notes}
                onChange={set('notes')}
                placeholder="Что здесь работает, особенности, чего не трогать"
              />
            </Field>
            <Field label="Способ входа" full hint="Пароль или ключ. Хранится зашифрованным.">
              <div className="flex gap-1 rounded-lg border border-border bg-bg/60 p-1">
                {(['password', 'key'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    // Смена способа входа СТИРАЕТ секрет прежнего: хранилище намеренно не держит
                    // два секрета сразу, иначе подключение молча шло бы старым, а признак
                    // «доступ есть» врал. Раньше это происходило без предупреждения — человек
                    // переключал тумблер посмотреть и терял пароль, который больше негде взять.
                    onClick={() => {
                      const losesSecret =
                        editing &&
                        m !== f.authMethod &&
                        dialog.device?.hasSecret === true &&
                        dialog.device.authType === f.authMethod
                      if (
                        losesSecret &&
                        !window.confirm(
                          f.authMethod === 'password'
                            ? 'Сохранённый пароль будет удалён — восстановить его приложение не сможет. Переключить на SSH-ключ?'
                            : 'Сохранённый приватный ключ будет удалён — восстановить его приложение не сможет. Переключить на пароль?'
                        )
                      )
                        return
                      setF((p) => ({ ...p, authMethod: m }))
                    }}
                    aria-pressed={f.authMethod === m}
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
                hint="Хранится зашифрованным. Пусто при правке — не менять."
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
                    aria-label="Приватный SSH-ключ"
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
                onClick={() => void geo()}
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
            <div className="flex gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-300 hover:bg-white/5"
              >
                Отмена
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
