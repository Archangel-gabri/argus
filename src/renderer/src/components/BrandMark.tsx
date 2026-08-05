// Знак компании — ОДИН на всё приложение.
//
// До этого его рисовали в трёх местах по-разному: карточка сервера знала про растровые
// логотипы, список подписок — только про векторный каталог, строка счёта — про свой набор.
// Результат владелец увидел сразу: у сервера в парке логотип FirstByte есть, а у платежа за
// тот же сервер в подписках его нет. Расхождение возникало не от разных данных, а от разного
// кода, и починить его в одном месте было нельзя.
//
// Ярусы, ни один из которых не ходит в сеть на показе:
//   1. векторный знак из каталога (`assets/brands`, `assets/providers`) — рисуется цветом текста;
//   2. растровый знак из поставки (`assets/logos`) — заранее приведён к одной краске
//      скриптом `tools/monochrome-logo.mjs`;
//   3. значок, скачанный с сайта самой компании по домену (лежит в userData, тоже серый);
//   4. буквы названия — чтобы строки различались даже без всякого знака.

import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { markFor } from '@/assets/providers/marks'
import { providerLogo } from '@/lib/providerLogos'
import { initialsOf, siteOf } from '../../../shared/brands'

const api = typeof window !== 'undefined' ? window.api : undefined

export function BrandMark({
  /** Всё, что известно о названии: имя, хостер, учреждение. Чем больше сказано, тем выше шанс. */
  name,
  /** Домен компании, если владелец его указал, — источник значка четвёртого яруса. */
  domain,
  size = 16,
  className
}: {
  name: string
  domain?: string | null
  size?: number
  className?: string
}): React.JSX.Element {
  const mark = markFor(name)
  const bundled = mark ? undefined : providerLogo(name.trim())
  // Домен владелец не вводит: он уже написал «Bybit» в названии счёта, и спрашивать после
  // этого ещё и сайт значит выдумывать работу. Явно указанный домен всё равно главнее.
  const site = domain ?? siteOf(name)
  const [fetched, setFetched] = useState<string | null>(null)

  // Значок по домену ищется только когда своих знаков нет и домен указан руками. Ответ уже
  // лежит на диске — если его нет, main сходит на сайт компании и положит.
  useEffect(() => {
    if (mark || bundled || !site || !api) return
    let alive = true
    void api.brand.icon(site).then((r) => {
      if (alive && r.ok && r.dataUrl) setFetched(r.dataUrl)
    })
    return () => {
      alive = false
    }
  }, [mark, bundled, site])

  if (mark) {
    return (
      <svg
        viewBox={mark.vb}
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden
        className={cn('shrink-0 text-slate-400', className)}
      >
        {mark.paths.map((path, i) => (
          <path key={i} d={path.d} fillRule={path.fillRule} clipRule={path.clipRule} />
        ))}
      </svg>
    )
  }

  const raster = bundled ?? fetched
  if (raster) {
    return (
      <img
        src={raster}
        alt=""
        aria-hidden
        draggable={false}
        style={{ width: size, height: size }}
        className={cn('shrink-0 object-contain', className)}
      />
    )
  }

  return (
    <span
      aria-hidden
      title={name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
      className={cn(
        'flex shrink-0 items-center justify-center rounded bg-slate-700/60 font-semibold uppercase leading-none text-slate-300',
        className
      )}
    >
      {initialsOf(name)}
    </span>
  )
}
