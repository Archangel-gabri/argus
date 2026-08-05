import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { useDevices } from '@/store/devices'
import { probesWithStoredSecret } from '@/lib/device-dialog-policy'
import type { DeviceDTO } from '@/types'
import type { FillFields, FormFields } from '@/components/device/form-fields'
import { useAlive } from '@/components/device/useAlive'

const api = typeof window !== 'undefined' ? window.api : undefined

/**
 * «Определить по SSH» — сходить на машину и подставить то, что она о себе скажет.
 *
 * Два пути: у уже заведённого устройства с сохранённым секретом спрашивают по id (сам секрет
 * остаётся в main), у нового — по набранным в форме учётным данным.
 */
export function SshProbe({
  fields,
  device,
  onFill
}: {
  fields: FormFields
  device: DeviceDTO | null
  onFill: FillFields
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const alive = useAlive()

  const probe = async (): Promise<void> => {
    if (!api) return
    setBusy(true)
    setMsg(null)
    try {
      if (
        device &&
        fields.authMethod === device.authType &&
        probesWithStoredSecret(true, device.hasSecret, fields.password, fields.privateKey)
      ) {
        const endpointUnchanged =
          fields.ip.trim() === device.ip &&
          (parseInt(fields.port, 10) || 22) === device.port &&
          (fields.user.trim() || 'root') === device.user &&
          (fields.jumpId || null) === device.jumpId
        if (!endpointUnchanged) {
          setMsg('✖ адрес или маршрут изменён: сначала сохрани, затем Argus проверит его старым секретом')
          return
        }
        // Секрет остаётся в main: renderer передаёт только id уже сохранённой записи.
        const r = await api.pc.metrics(device.id)
        if (!alive.current) return
        useDevices.getState().updateMetrics(device.id, r)
        if (r.status !== 'online') {
          setMsg(
            r.status === 'unknown'
              ? '✖ один опрос не дал ответа — состояние неизвестно'
              : '✖ хост не ответил на два опроса подряд'
          )
          return
        }
        onFill((p) => ({ ...p, os: r.current || p.os, status: 'online' }))
        setMsg(`✓ ${r.current || 'хост отвечает'} · CPU ${r.cpu ?? '—'}% · RAM ${r.ramTotal ?? '—'} ГБ`)
        return
      }

      const r = await api.ssh.probeHost({
        host: fields.ip.trim(),
        port: parseInt(fields.port, 10) || 22,
        user: fields.user.trim() || 'root',
        password: fields.authMethod === 'password' ? fields.password : '',
        privateKey: fields.authMethod === 'key' ? fields.privateKey || undefined : undefined,
        passphrase: fields.authMethod === 'key' ? fields.passphrase || undefined : undefined
      })
      if (!alive.current) return
      if (r.ok) {
        onFill((p) => ({ ...p, os: r.os || p.os, name: p.name || r.hostname || p.name, status: 'online' }))
        setMsg(`✓ ${r.os ?? 'ok'} · ${r.cores ?? '?'} ядер · ${r.ramTotal ?? '?'} ГБ RAM`)
      } else {
        setMsg(`✖ ${r.error ?? 'не удалось'}`)
      }
    } catch (cause) {
      if (alive.current) setMsg(`✖ ${cause instanceof Error ? cause.message : 'SSH-проверка не завершилась'}`)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void probe()}
        disabled={
          busy ||
          !fields.ip.trim() ||
          // При правке секрет уже лежит в хранилище, поля пустые намеренно — раньше из-за
          // этого кнопка была мертва ровно там, где она нужнее всего.
          (!device && (fields.authMethod === 'password' ? !fields.password : !fields.privateKey))
        }
        className="flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs font-medium text-slate-200 ring-1 ring-border transition-colors hover:bg-card-hover disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5 text-accent" />
        )}
        Определить по SSH
      </button>
      {/* Кнопки ряда стоят слева, ответы обеих проверок — за ними: в разметке сообщение идёт
          сразу за своей кнопкой, порядок на экране держит `order`. */}
      {msg && <span className="order-1 text-xs text-slate-500">{msg}</span>}
    </>
  )
}
