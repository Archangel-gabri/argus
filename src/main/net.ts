// IP-геолокация + хостер через HTTPS-сервис ipwho.is (без ключа). Питает авто-подстановку
// страна/флаг/провайдер при добавлении устройства. Приватность: запрос ТОЛЬКО по кнопке
// (не автоматически), уходит один IP по TLS на публичный geo-сервис.

export interface IpInfo {
  ok: boolean
  country?: string
  countryCode?: string
  city?: string
  flag?: string
  provider?: string
  domain?: string
  asn?: string
  error?: string
}

/** Двухбуквенный код страны → эмодзи-флаг (fallback, если сервис не прислал emoji). */
function codeToFlag(cc: string): string {
  const c = cc.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c)) return ''
  const base = 0x1f1e6
  return String.fromCodePoint(base + (c.charCodeAt(0) - 65), base + (c.charCodeAt(1) - 65))
}

/** Короткое имя хостера: домен (extravm.com→ExtraVM) либо org/isp без юр-суффиксов. */
function tidyProvider(domain: string, org: string, isp: string): string {
  if (domain) {
    const base = domain.split('.')[0]
    if (base) return base.charAt(0).toUpperCase() + base.slice(1)
  }
  return (org || isp || '')
    .replace(/\b(LLC|LTD|LIMITED|SAS|GMBH|INC|SL|SOCIEDAD LIMITADA|EHF|B\.?V\.?)\b\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const isPrivate = (ip: string): boolean =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1|fe80:|fc|fd)/i.test(ip)

export async function ipLookup(ip: string): Promise<IpInfo> {
  const clean = (ip || '').trim()
  if (!clean) return { ok: false, error: 'Пустой IP' }
  if (isPrivate(clean)) return { ok: false, error: 'Приватный/локальный IP — гео недоступно' }
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}?fields=success,message,country,country_code,city,connection,flag`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!r.ok) return { ok: false, error: `geo HTTP ${r.status}` }
    const d = (await r.json()) as {
      success: boolean
      message?: string
      country?: string
      country_code?: string
      city?: string
      flag?: { emoji?: string }
      connection?: { asn?: number; org?: string; isp?: string; domain?: string }
    }
    if (!d.success) return { ok: false, error: d.message || 'geo failed' }
    const conn = d.connection ?? {}
    return {
      ok: true,
      country: d.country,
      countryCode: d.country_code,
      city: d.city,
      flag: d.flag?.emoji || (d.country_code ? codeToFlag(d.country_code) : ''),
      provider: tidyProvider(conn.domain ?? '', conn.org ?? '', conn.isp ?? ''),
      domain: conn.domain || undefined,
      asn: conn.asn ? `AS${conn.asn}` : undefined
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
