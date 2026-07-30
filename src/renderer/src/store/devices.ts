import { create } from 'zustand'
import type { DeviceDTO, DeviceInput } from '@/types'
import { FALLBACK_DEVICES } from '@/data/mock'

const api = typeof window !== 'undefined' ? window.api : undefined

/** Идёт ли полный опрос прямо сейчас — чтобы проходы не накладывались друг на друга. */
let metricsInFlight = false

/** Подряд идущие промахи быстрой проверки живости, по устройствам (гасим флаппинг). */
const missStreak = new Map<string, number>()

interface DevicesStore {
  devices: DeviceDTO[]
  loaded: boolean
  load: () => Promise<void>
  create: (input: DeviceInput) => Promise<{ ok: boolean; error?: string }>
  update: (id: string, input: DeviceInput) => Promise<{ ok: boolean; error?: string }>
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  updateMetrics: (
    id: string,
    m: {
      cpu?: number
      ramUsed?: number
      ramTotal?: number
      status?: DeviceDTO['status']
      disk?: number
      uptime?: number
      load1?: number
      netRx?: number
      netTx?: number
      swapUsed?: number
      swapTotal?: number
      tempCpu?: number
    }
  ) => void
  refreshLiveness: () => Promise<void>
  refreshMetrics: () => Promise<void>
  refreshOsStatus: () => Promise<void>
  refreshOne: (deviceId: string) => Promise<void>
}

export const useDevices = create<DevicesStore>((set, get) => ({
  devices: api ? [] : FALLBACK_DEVICES,
  loaded: !api,

  load: async () => {
    if (!api) {
      set({ devices: FALLBACK_DEVICES, loaded: true })
      return
    }
    // Сначала рисуем последнее известное состояние из базы (мгновенно), потом уточняем.
    // Живые метрики, уже набранные в этой сессии, кэшем НЕ перетираем — иначе повторная
    // загрузка списка воскрешала бы выключенный хост как «online» из старого снимка.
    const list = await api.devices.list()
    const prev = new Map(get().devices.map((d) => [d.id, d]))
    set({
      devices: list.map((d) => {
        const p = prev.get(d.id)
        return p ? { ...d, status: p.status, cpu: p.cpu, ram: p.ram, runningOs: p.runningOs } : d
      }),
      loaded: true
    })
    void get().refreshLiveness()
  },

  create: async (input) => {
    if (!api) return { ok: false, error: 'недоступно вне приложения' }
    const r = await api.devices.create(input)
    if (r.ok && r.device) set({ devices: [...get().devices, r.device] })
    return { ok: r.ok, error: r.error }
  },

  update: async (id, input) => {
    if (!api) return { ok: false, error: 'недоступно вне приложения' }
    const r = await api.devices.update(id, input)
    if (r.ok && r.device) {
      const updated = r.device
      // Сливаем, а не подменяем: в ответе из базы нет эфемерных данных (какая ОС запущена,
      // аптайм, диск, температура, сеть), и полная замена стирала бы их с карточки после
      // любого сохранения — вплоть до следующего полного опроса.
      set({
        devices: get().devices.map((d) =>
          d.id === id
            ? {
                ...d,
                ...updated,
                status: d.status,
                runningOs: d.runningOs,
                disk: d.disk,
                uptime: d.uptime,
                load1: d.load1,
                netRx: d.netRx,
                netTx: d.netTx,
                swapUsed: d.swapUsed,
                swapTotal: d.swapTotal,
                tempCpu: d.tempCpu,
                lastSeen: d.lastSeen
              }
            : d
        )
      })
    }
    return { ok: r.ok, error: r.error }
  },

  remove: async (id) => {
    if (!api) {
      set({ devices: get().devices.filter((d) => d.id !== id) })
      return { ok: true }
    }
    // Убираем из UI ТОЛЬКО если удаление в vault реально прошло — иначе устройство «исчезало»
    // из списка, оставаясь в базе (провалившееся удаление выглядело как успех).
    const r = await api.devices.remove(id)
    if (r?.ok) set({ devices: get().devices.filter((d) => d.id !== id) })
    return { ok: !!r?.ok, error: r?.error }
  },

  updateMetrics: (id, m) =>
    set({
      devices: get().devices.map((d) =>
        d.id === id
          ? {
              ...d,
              cpu: m.cpu ?? d.cpu,
              ram: { used: m.ramUsed ?? d.ram.used, total: m.ramTotal ?? d.ram.total },
              status: m.status ?? d.status,
              disk: m.disk ?? d.disk,
              uptime: m.uptime ?? d.uptime,
              load1: m.load1 ?? d.load1,
              netRx: m.netRx ?? d.netRx,
              netTx: m.netTx ?? d.netTx,
              swapUsed: m.swapUsed ?? d.swapUsed,
              swapTotal: m.swapTotal ?? d.swapTotal,
              tempCpu: m.tempCpu ?? d.tempCpu
            }
          : d
      )
    }),

  // Быстрая живость: один TCP-коннект на устройство. Даёт точку «онлайн/офлайн» за сотни
  // миллисекунд, пока полноценный опрос (секунды) ещё едет за цифрами. Метрики НЕ трогаем —
  // только статус, иначе затрём свежие значения нулями.
  refreshLiveness: async () => {
    if (!api) return
    const reach = await api.devices.liveness()
    set({
      devices: get().devices.map((d) => {
        const r = reach[d.id]
        if (!r) return d
        if (r.up) {
          missStreak.set(d.id, 0)
          return { ...d, status: 'online' }
        }
        // Один промах в offline НЕ роняем: канал до дальних нод флапает (замерено — 1 ложный
        // промах из 6 на LAX), и мигание «online→offline→online» врало бы чаще, чем помогало.
        const n = (missStreak.get(d.id) ?? 0) + 1
        missStreak.set(d.id, n)
        return n >= 2 ? { ...d, status: 'offline' } : d
      })
    })
  },

  // Agentless: probe only devices that have a real host + stored credential.
  // Dual-boot ПК (alt) обрабатываются через refreshOsStatus (у них живой может быть Windows-эндпоинт).
  refreshMetrics: async () => {
    if (!api) return
    // Защита от наложения проходов: один опрос может идти дольше интервала (офлайновый хост —
    // это таймаут в 10с), и без флага проходы копились бы очередью, без конца долбя SSH.
    if (metricsInFlight) return
    metricsInFlight = true
    try {
      // Windows-машина идёт по своей ветке, даже если вторая ОС не заведена: Linux-зонд на ней
      // возвращал мусор, который разбирался в нули и выглядел как настоящие метрики.
      const isWin = (d: { os: string }): boolean => /win/i.test(d.os)
      const eligible = get().devices.filter(
        (d) => d.hasSecret && !d.ip.includes('x.x') && d.altOs.length === 0 && !isWin(d)
      )
      await Promise.all(
        eligible.map(async (d) => {
          // Хост, который быстрая проверка уже уверенно признала мёртвым, полным опросом не
          // мучаем: это 10с SSH-таймаута на ровном месте, а ответ известен. Как только живость
          // (раз в 10с) увидит его снова, следующий проход соберёт метрики.
          if (d.status === 'offline') return
          const r = await api.ssh.probe(d.id)
          get().updateMetrics(d.id, r.ok ? r : { status: 'offline' })
        })
      )
      await get().refreshOsStatus()
    } finally {
      metricsInFlight = false
    }
  },

  // Dual-boot: живая ОС + метрики этой ОS (OS-aware) → статус + runningOs + cpu/ram/disk/uptime.
  refreshOsStatus: async () => {
    if (!api) return
    // Сюда же попадают одиночные Windows-хосты — у них OS-aware путь единственно верный.
    const pcs = get().devices.filter(
      (d) => d.altOs.length > 0 || (/win/i.test(d.os) && d.hasSecret && !d.ip.includes('x.x'))
    )
    await Promise.all(
      pcs.map(async (d) => {
        const r = await api.pc.metrics(d.id)
        const running = r.family === 'off' ? null : r.current || (r.family === 'windows' ? 'Windows' : d.os)
        set({
          devices: get().devices.map((x) =>
            x.id === d.id
              ? {
                  ...x,
                  status: r.family === 'off' ? 'offline' : 'online',
                  runningOs: running,
                  cpu: r.cpu ?? x.cpu,
                  ram: { used: r.ramUsed ?? x.ram.used, total: r.ramTotal ?? x.ram.total },
                  disk: r.disk ?? x.disk,
                  uptime: r.uptime ?? x.uptime,
                  load1: r.load1 ?? x.load1,
                  netRx: r.netRx ?? x.netRx,
                  netTx: r.netTx ?? x.netTx,
                  swapUsed: r.swapUsed ?? x.swapUsed,
                  swapTotal: r.swapTotal ?? x.swapTotal,
                  tempCpu: r.tempCpu ?? x.tempCpu
                }
              : x
          )
        })
      })
    )
  },

  // Точечный опрос одного устройства (для учащённого refresh при открытой карточке).
  refreshOne: async (deviceId) => {
    if (!api) return
    const d = get().devices.find((x) => x.id === deviceId)
    if (!d || !d.hasSecret || d.ip.includes('x.x')) return
    if (d.altOs.length > 0) {
      const r = await api.pc.metrics(deviceId)
      const running = r.family === 'off' ? null : r.current || (r.family === 'windows' ? 'Windows' : d.os)
      set({
        devices: get().devices.map((x) =>
          x.id === deviceId
            ? {
                ...x,
                status: r.family === 'off' ? 'offline' : 'online',
                runningOs: running,
                cpu: r.cpu ?? x.cpu,
                ram: { used: r.ramUsed ?? x.ram.used, total: r.ramTotal ?? x.ram.total },
                disk: r.disk ?? x.disk,
                uptime: r.uptime ?? x.uptime,
                load1: r.load1 ?? x.load1,
                netRx: r.netRx ?? x.netRx,
                netTx: r.netTx ?? x.netTx,
                swapUsed: r.swapUsed ?? x.swapUsed,
                swapTotal: r.swapTotal ?? x.swapTotal,
                tempCpu: r.tempCpu ?? x.tempCpu
              }
            : x
        )
      })
    } else {
      const r = await api.ssh.probe(deviceId)
      get().updateMetrics(deviceId, r.ok ? r : { status: 'offline' })
    }
  }
}))

// Фоновая гео-подстановка из main: обновляем ТОЛЬКО country/flag/provider, чтобы не затирать
// живые метрики (cpu/ram/status), приходящие поллингом. Подписка одна на жизнь процесса.
api?.devices.onGeo(({ device }) => {
  useDevices.setState((s) => ({
    devices: s.devices.map((d) =>
      d.id === device.id ? { ...d, country: device.country, flag: device.flag, provider: device.provider } : d
    )
  }))
})

export function totals(devices: DeviceDTO[]): { monthly: number; yearly: number } {
  const monthly = devices.reduce((s, d) => s + d.cost.usd, 0)
  return { monthly, yearly: monthly * 12 }
}

export function spendByProvider(devices: DeviceDTO[]): { provider: string; usd: number }[] {
  const m = devices.reduce<Record<string, number>>((acc, d) => {
    acc[d.provider] = (acc[d.provider] ?? 0) + d.cost.usd
    return acc
  }, {})
  // Только реальные траты — паспорт-устройства (Home/Samsung/…) с нулевой ценой не в разбивке.
  return Object.entries(m)
    .filter(([, usd]) => usd > 0)
    .map(([provider, usd]) => ({ provider, usd }))
    .sort((a, b) => b.usd - a.usd)
}
