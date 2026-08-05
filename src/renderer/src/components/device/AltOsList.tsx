import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Field } from '@/components/device/Field'
import { inputCls, type FillFields, type FormFields } from '@/components/device/form-fields'

/**
 * Соседние ОС той же машины (multi-boot): адрес, учётка, свой порт и своя загрузочная запись.
 *
 * `onBootTargetReset` дёргается при удалении строки: цель для найденной загрузочной записи
 * адресуется индексом, а после удаления индексы съезжают.
 */
export function AltOsList({
  altOs,
  onFill,
  onBootTargetReset
}: {
  altOs: FormFields['altOs']
  onFill: FillFields
  onBootTargetReset: () => void
}): React.JSX.Element {
  return (
    <Field label="Другие системы на этой машине" full hint="Для машин с несколькими ОС. Ключ берётся тот же, что у основной; порт — тоже, если не указать свой. Приложение само определит, какая система сейчас запущена.">
      <div className="space-y-2">
        {altOs.map((a, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border/70 bg-bg/30 p-2">
            <div className="flex items-center gap-2">
              <input
                aria-label={`ОС ${i + 2}`}
                className={cn(inputCls, 'flex-1')}
                value={a.os}
                list="os-list"
                placeholder="Windows 11"
                onChange={(e) =>
                  onFill((p) => ({
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
                  onFill((p) => ({
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
                  onFill((p) => ({
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
                  onFill((p) => ({
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
                  onBootTargetReset()
                  onFill((p) => ({ ...p, altOs: p.altOs.filter((_, j) => j !== i) }))
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
                onFill((p) => ({
                  ...p,
                  altOs: p.altOs.map((x, j) => (j === i ? { ...x, bootEntry: event.target.value } : x))
                }))
              }
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() => onFill((p) => ({ ...p, altOs: [...p.altOs, { os: '', ip: '', user: 'root' }] }))}
          className="inline-flex items-center gap-1.5 rounded-md bg-card px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-border hover:bg-card-hover"
        >
          + добавить ОС
        </button>
      </div>
    </Field>
  )
}
