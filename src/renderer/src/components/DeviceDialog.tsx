import { useMemo, useRef, useState, type FormEvent, type RefObject } from 'react'
import { X, Loader2, Upload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUI, type DialogState } from '@/store/ui'
import { useDevices } from '@/store/devices'
import type { Currency, DeviceDTO, DeviceInput, DeviceKind } from '@/types'
import { CURRENCY_CODES } from '@/types'
import { shouldDismissOverlay, useOverlayA11y } from '@/lib/overlay'
import { type BootTarget } from '@/lib/device-dialog-policy'
import { Field } from '@/components/device/Field'
import { IconPicker } from '@/components/device/IconPicker'
import { EMPTY, fieldsOf, inputCls, type FormFields } from '@/components/device/form-fields'
import { useAlive } from '@/components/device/useAlive'
import { GeoLookup } from '@/components/device/GeoLookup'
import { SshProbe } from '@/components/device/SshProbe'
import { BootEntries } from '@/components/device/BootEntries'
import { AltOsList } from '@/components/device/AltOsList'

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
const api = typeof window !== 'undefined' ? window.api : undefined

/** Диалог в открытом состоянии — форма существует только для него. */
type OpenDialog = Exclude<DialogState, { mode: 'closed' }>

export function DeviceDialog(): React.JSX.Element | null {
  const dialog = useUI((s) => s.dialog)
  const close = useUI((s) => s.closeDialog)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Механика overlay живёт ЗДЕСЬ, а не в форме: она отвечает за окно как таковое (Escape,
  // начальный фокус, возврат фокуса открывшей кнопке) и не должна начинаться заново от того,
  // что внутри пересоздалась форма.
  useOverlayA11y({
    open: dialog.mode !== 'closed',
    onEscape: close,
    containerRef: dialogRef,
    initialFocusRef: nameRef
  })

  if (dialog.mode === 'closed') return null
  // Каждому устройству — своя форма: с прежней уходят набранные пароль и ключ (раньше они
  // оставались в состоянии React до конца сессии), сообщения проб и прочитанные с ДРУГОЙ
  // машины загрузочные записи.
  return (
    <DeviceForm
      key={dialog.mode === 'edit' ? `edit:${dialog.device.id}` : 'new'}
      dialog={dialog}
      close={close}
      dialogRef={dialogRef}
      nameRef={nameRef}
    />
  )
}

function DeviceForm({
  dialog,
  close,
  dialogRef,
  nameRef
}: {
  dialog: OpenDialog
  close: () => void
  dialogRef: RefObject<HTMLDivElement | null>
  nameRef: RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const create = useDevices((s) => s.create)
  const update = useDevices((s) => s.update)
  const devices = useDevices((s) => s.devices)
  const editing = dialog.mode === 'edit'
  const device: DeviceDTO | null = dialog.mode === 'edit' ? dialog.device : null

  const [initial] = useState<FormFields>(() => (device ? fieldsOf(device) : EMPTY))
  const [f, setF] = useState<FormFields>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Цель для найденной загрузочной записи. Живёт в форме, а не в блоке записей: список
  // соседних ОС при удалении строки возвращает её к основной ОС — цель адресуется индексом,
  // и после удаления индексы съезжают.
  const [bootTarget, setBootTarget] = useState<BootTarget>('primary')
  // Набран ли текст в блоке ИИ-заполнения — сам текст живёт там же, форме нужен только факт.
  const keyFileRef = useRef<HTMLInputElement>(null)
  const alive = useAlive()

  // Значения на момент открытия: по ним видно, трогали ли форму (клик по подложке не должен
  // уничтожать начатое).
  const baseline = useMemo(() => JSON.stringify(initial), [initial])

  const loadKeyFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    try {
      const text = await file.text()
      if (alive.current) setF((p) => ({ ...p, privateKey: text, authMethod: 'key' }))
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Не удалось прочитать файл ключа')
    }
  }

  const dirty = JSON.stringify(f) !== baseline

  const set =
    (k: keyof FormFields) =>
    (e: { target: { value: string } }): void =>
      setF((p) => ({ ...p, [k]: e.target.value }))

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
    try {
      const r = device ? await update(device.id, input) : await create(input)
      if (!alive.current) return
      if (r.ok) close()
      else setError(r.error ?? 'Не удалось сохранить')
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Не удалось сохранить')
    } finally {
      if (alive.current) setBusy(false)
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
            <BootEntries
              fields={f}
              device={device}
              target={bootTarget}
              onTarget={setBootTarget}
              onFill={setF}
            />
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
                  .filter((d) => d.id !== device?.id)
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
              <AltOsList altOs={f.altOs} onFill={setF} onBootTargetReset={() => setBootTarget('primary')} />
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
                        device?.hasSecret === true &&
                        device.authType === f.authMethod
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
              <SshProbe fields={f} device={device} onFill={setF} />
              <GeoLookup ip={f.ip} onFill={setF} />
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
