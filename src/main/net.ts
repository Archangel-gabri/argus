// IP-геолокация + хостер (ip-api.com, без ключа). Питает авто-подстановку страна/флаг/провайдер
// при добавлении устройства. Приватность: уходит только IP на публичный geo-сервис.

export interface IpInfo {
  ok: boolean
  country?: string
  countryCode?: string
  flag?: string
  provider?: string
  asn?: string
  error?: string
}

/** Двухбуквенный код страны → эмодзи-флаг (regional indicators). Работает для всех стран. */
function codeToFlag(cc: string): string {
  const c = cc.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return ''
  const base = 0x1f1e6
  return String.fromCodePoint(base + (c.charCodeAt(0) - 65), base + (c.charCodeAt(1) - 65))
}

/** Короткое имя хостера из org/isp (обрезаем юр-суффиксы). */
function tidyProvider(org: string, isp: string): string {
  const raw = (org || isp || '').trim()
  return raw
    .replace(/\b(LLC|LTD|LIMITED|SAS|GMBH|INC|SL|SOCIEDAD LIMITADA|EHF|B\.?V\.?)\b\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export async function ipLookup(ip: string): Promise<IpInfo> {
  const clean = (ip || '').trim()
  if (!clean || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(clean)) {
    return { ok: false, error: 'Приватный/локальный IP — гео недоступно' }
  }
  try {
    const r = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,message,country,countryCode,isp,org,as`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!r.ok) return { ok: false, error: `geo HTTP ${r.status}` }
    const d = (await r.json()) as {
      status: string
      message?: string
      country?: string
      countryCode?: string
      isp?: string
      org?: string
      as?: string
    }
    if (d.status !== 'success') return { ok: false, error: d.message || 'geo failed' }
    return {
      ok: true,
      country: d.country,
      countryCode: d.countryCode,
      flag: d.countryCode ? codeToFlag(d.countryCode) : '',
      provider: tidyProvider(d.org ?? '', d.isp ?? ''),
      asn: d.as
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
