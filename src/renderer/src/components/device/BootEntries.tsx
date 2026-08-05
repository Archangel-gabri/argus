import { useState } from 'react'
import { cn } from '@/lib/cn'
import { assignBootEntry, selectedBootEntry, type BootTarget } from '@/lib/device-dialog-policy'
import type { DeviceDTO } from '@/types'
import { Field } from '@/components/device/Field'
import { inputCls, type FillFields, type FormFields } from '@/components/device/form-fields'
import { useAlive } from '@/components/device/useAlive'

const api = typeof window !== 'undefined' ? window.api : undefined

/**
 * Загрузочная запись основной ОС и чтение списка записей с самой машины.
 *
 * Это то, ради чего всё затевалось: без записи переключение ОС не выбирает систему, а узнать
 * её можно было только руками через bcdedit/efibootmgr — и человек просто не знал, что вписывать.
 *
 * `target` приходит снаружи: найденную запись назначают либо основной ОС, либо соседней, а
 * список соседних ОС при удалении строки возвращает цель к основной.
 */
export function BootEntries({
  fields,
  device,
  target,
  onTarget,
  onFill
}: {
  fields: FormFields
  device: DeviceDTO | null
  target: BootTarget
  onTarget: (target: BootTarget) => void
  onFill: FillFields
}): React.JSX.Element {
  // Записи, прочитанные с самой машины. null — ещё не спрашивали.
  const [list, setList] = useState<Array<{ id: string; label: string }> | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useAlive()

  const load = async (): Promise<void> => {
    // Спрашивать можно только у уже заведённого устройства: у нового ещё нет записи в хранилище,
    // а значит и адреса, по которому идти.
    if (!api || !device) return
    setBusy(true)
    setMsg(null)
    setList(null)
    try {
      const r = await api.pc.bootEntries(device.id)
      if (!alive.current) return
      if (!r.ok) {
        setMsg(`✖ ${r.error ?? 'не удалось прочитать'}`)
        return
      }
      setList(r.entries)
      setMsg(r.entries.length ? `найдено записей: ${r.entries.length} (прочитано в ${r.os})` : 'записей не найдено')
    } catch (cause) {
      if (alive.current) setMsg(`✖ ${cause instanceof Error ? cause.message : 'не удалось прочитать записи'}`)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
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
            value={fields.bootEntry}
            onChange={(event) => onFill((p) => ({ ...p, bootEntry: event.target.value }))}
            placeholder="0002"
          />
          {device && (
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy}
              className="shrink-0 rounded-md bg-card px-2.5 py-1.5 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-card-hover disabled:opacity-50"
            >
              {busy ? 'читаю…' : 'Спросить машину'}
            </button>
          )}
        </div>
        {msg && <p className="text-[11px] text-slate-500">{msg}</p>}
        {list && list.length > 0 && (
          <div className="space-y-1 rounded-md border border-border bg-bg/40 p-1.5">
            <label className="mb-1 flex items-center gap-2 px-1 text-[11px] text-slate-400">
              <span className="shrink-0">Назначить для</span>
              <select
                aria-label="Целевая ОС для загрузочной записи"
                value={target}
                onChange={(event) => onTarget(event.target.value as BootTarget)}
                className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px] text-slate-200"
              >
                <option value="primary">{fields.os || 'основная ОС'}</option>
                {fields.altOs.map((os, index) => (
                  <option key={index} value={`alt:${index}`}>
                    {os.os || `ОС ${index + 2}`}
                  </option>
                ))}
              </select>
            </label>
            {list.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => onFill((p) => assignBootEntry(p, target, b.id))}
                aria-pressed={selectedBootEntry(fields, target) === b.id}
                className={cn(
                  'block w-full rounded px-2 py-1 text-left text-[11px] leading-snug hover:bg-white/5',
                  selectedBootEntry(fields, target) === b.id ? 'text-accent' : 'text-slate-300'
                )}
                title={`${b.id} — ${b.label}`}
              >
                {/* Без обрезки: обрезался ровно путь загрузчика, а он тут единственное,
                    по чему записи вообще можно различить. */}
                <span className="block break-all">{b.label}</span>
                <span className="block break-all font-mono text-[10px] text-slate-400">{b.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  )
}
