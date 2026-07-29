import type {
  DeviceDTO,
  DeviceInput,
  VaultState,
  Snippet,
  Subscription,
  SubscriptionInput,
  Wallet,
  WalletInput,
  WalletBalance,
  MetricSnapshot,
  AiAccount,
  AiAccountInput,
  AiCheck,
  PowerResult,
  PowerDiag,
  LiveMetrics,
  HardwareInfo,
  ScreenPreflight
} from '../main/types'
import type { ParsedHost } from '../main/sshconfig'
import type { SftpEntry } from '../main/sftp'
import type { ForwardInfo } from '../main/forward'
import type { ListeningPort } from '../main/ports'
import type { AgentStatus, ProvisionResult } from '../main/agent'

export type VaultResult = { ok: boolean; error?: string; state: VaultState }
export type DeviceResult = { ok: boolean; error?: string; device?: DeviceDTO }
export type ProbeResult = {
  ok: boolean
  status: 'online' | 'offline'
  cpu?: number
  ramUsed?: number
  ramTotal?: number
  disk?: number
  uptime?: number
  load1?: number
  netRx?: number
  netTx?: number
  swapUsed?: number
  swapTotal?: number
  tempCpu?: number
  metrics?: LiveMetrics
  error?: string
}

export interface ArgusApi {
  vault: {
    state: () => Promise<VaultState>
    initialize: (password: string) => Promise<VaultResult>
    unlock: (password: string) => Promise<VaultResult>
    lock: () => Promise<VaultState>
    changePassword: (current: string, next: string) => Promise<{ ok: boolean; error?: string }>
  }
  devices: {
    list: () => Promise<DeviceDTO[]>
    /** Быстрая TCP-живость по всему парку: id → { up, ms }. Мс вместо секунд. */
    liveness: () => Promise<Record<string, { up: boolean; ms: number }>>
    /** Диалог выбора своей картинки устройства → data-URL. */
    pickIcon: () => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
    create: (input: DeviceInput) => Promise<DeviceResult>
    update: (id: string, input: DeviceInput) => Promise<DeviceResult>
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>
    onGeo: (cb: (p: { device: DeviceDTO }) => void) => () => void
  }
  ssh: {
    open: (deviceId: string, cols: number, rows: number) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
    input: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    close: (sessionId: string) => void
    attach: (sessionId: string) => void
    probe: (deviceId: string) => Promise<ProbeResult>
    exec: (deviceId: string, command: string) => Promise<{ ok: boolean; output: string; error?: string }>
    probeHost: (opts: {
      host: string
      port: number
      user: string
      password: string
      privateKey?: string
      passphrase?: string
    }) => Promise<{
      ok: boolean
      os?: string
      hostname?: string
      cores?: number
      cpu?: number
      ramUsed?: number
      ramTotal?: number
      error?: string
    }>
    forgetHostKey: (host: string, port: number) => Promise<{ ok: boolean }>
    trustDeviceKey: (
      deviceId: string
    ) => Promise<{ ok: boolean; host?: string; port?: number; error?: string }>
    onData: (cb: (p: { sessionId: string; data: string }) => void) => () => void
    onExit: (cb: (p: { sessionId: string }) => void) => () => void
  }
  sshconfig: {
    parse: () => Promise<ParsedHost[]>
    import: (hosts: ParsedHost[]) => Promise<{ ok: boolean; added: number }>
  }
  sftp: {
    open: (deviceId: string) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
    list: (
      sessionId: string,
      path: string
    ) => Promise<{ ok: boolean; path: string; entries?: SftpEntry[]; error?: string }>
    download: (sessionId: string, path: string) => Promise<{ ok: boolean; error?: string }>
    upload: (sessionId: string, remoteDir: string) => Promise<{ ok: boolean; name?: string; error?: string }>
    remove: (sessionId: string, path: string, isDir: boolean) => Promise<{ ok: boolean; error?: string }>
    close: (sessionId: string) => void
  }
  snippets: {
    list: () => Promise<Snippet[]>
    create: (name: string, command: string) => Promise<Snippet>
    remove: (id: string) => Promise<{ ok: boolean }>
  }
  discovery: {
    tailscale: () => Promise<ParsedHost[]>
  }
  subs: {
    list: () => Promise<Subscription[]>
    create: (input: SubscriptionInput) => Promise<Subscription>
    update: (id: string, input: SubscriptionInput) => Promise<Subscription>
    remove: (id: string) => Promise<{ ok: boolean }>
  }
  wallets: {
    list: () => Promise<Wallet[]>
    create: (input: WalletInput) => Promise<Wallet>
    update: (id: string, input: WalletInput) => Promise<Wallet>
    remove: (id: string) => Promise<{ ok: boolean }>
    balance: (chain: string, address: string) => Promise<WalletBalance>
  }
  metrics: {
    history: (deviceId: string, limit?: number) => Promise<MetricSnapshot[]>
    live: (
      deviceId: string
    ) => Promise<{ ok: boolean; family: string; os: string; metrics: LiveMetrics | null }>
  }
  ai: {
    list: () => Promise<AiAccount[]>
    create: (input: AiAccountInput) => Promise<AiAccount>
    update: (id: string, input: AiAccountInput) => Promise<AiAccount>
    remove: (id: string) => Promise<{ ok: boolean }>
    check: (id: string) => Promise<AiCheck>
  }
  forward: {
    open: (
      deviceId: string,
      localPort: number,
      remoteHost: string,
      remotePort: number
    ) => Promise<{ ok: boolean; id?: string; error?: string }>
    list: (deviceId: string) => Promise<ForwardInfo[]>
    close: (id: string) => void
  }
  ports: {
    list: (deviceId: string) => Promise<{ ok: boolean; ports: ListeningPort[]; error?: string }>
  }
  hw: {
    get: (deviceId: string) => Promise<{ info: HardwareInfo; collectedAt: number } | null>
    refresh: (deviceId: string) => Promise<{ ok: boolean; info?: HardwareInfo; error?: string }>
  }
  screen: {
    preflight: (deviceId: string) => Promise<ScreenPreflight>
    open: (
      deviceId: string,
      opts: { password: string; remember?: boolean }
    ) => Promise<{ ok: boolean; error?: string }>
    forgetPassword: (deviceId: string) => Promise<{ ok: boolean }>
    claim: (handle: string) => Promise<{
      ok: boolean
      mode?: 'agent' | 'rdp'
      wsPort?: number
      token?: string
      url?: string
      error?: string
    }>
  }
  agent: {
    status: (deviceId: string) => Promise<AgentStatus>
    provision: (deviceId: string) => Promise<ProvisionResult>
    forget: (deviceId: string) => Promise<{ ok: boolean }>
  }
  win: {
    setFullScreen: (on: boolean) => Promise<boolean>
    isFullScreen: () => Promise<boolean>
    minimize: () => void
    close: () => void
  }
  clip: {
    read: () => Promise<string>
    write: (text: string) => void
  }
  assist: {
    parseDevice: (text: string) => Promise<AssistResult>
  }
  net: {
    ipLookup: (ip: string) => Promise<{
      ok: boolean
      country?: string
      countryCode?: string
      city?: string
      flag?: string
      provider?: string
      domain?: string
      asn?: string
      error?: string
    }>
  }
  pc: {
    whichOs: (deviceId: string) => Promise<{ current: string; family: 'linux' | 'windows' | 'off' }>
    bootEntries: (
      deviceId: string
    ) => Promise<{ ok: boolean; os: string; entries: Array<{ id: string; label: string }>; error?: string }>
    metrics: (deviceId: string) => Promise<{
      current: string
      family: 'linux' | 'windows' | 'off'
      cpu?: number
      ramUsed?: number
      ramTotal?: number
      disk?: number
      uptime?: number
      load1?: number
      netRx?: number
      netTx?: number
      swapUsed?: number
      swapTotal?: number
      tempCpu?: number
      metrics?: LiveMetrics
    }>
    boot: (
      deviceId: string,
      targetOs: string
    ) => Promise<{ ok: boolean; os: string; output?: string; error?: string }>
    power: (deviceId: string, action: 'reboot' | 'poweroff' | 'suspend') => Promise<PowerResult>
    wake: (deviceId: string) => Promise<{ ok: boolean; error?: string }>
    powerDiag: (deviceId: string) => Promise<PowerDiag>
  }
}

export interface AssistResult {
  ok: boolean
  fields?: Partial<DeviceInput>
  model?: string
  error?: string
}

declare global {
  interface Window {
    api: ArgusApi
  }
}

export {}
