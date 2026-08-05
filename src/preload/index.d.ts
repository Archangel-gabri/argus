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
  AiAccess,
  AiAccessInput,
  AiAccessModel,
  AiCheck,
  AiPrice,
  AiQuotaSlice,
  FinanceAccount,
  FinanceAccountInput,
  AiUsageSummary,
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
  status: 'online' | 'offline' | 'unknown'
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
    /** Быстрая SSH-живость; unknown = из этой точки измерить нельзя. */
    liveness: () => Promise<Record<string, { status: 'online' | 'offline' | 'unknown'; ms: number }>>
    /** Диалог выбора своей картинки устройства → data-URL. */
    pickIcon: () => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
    create: (input: DeviceInput) => Promise<DeviceResult>
    update: (id: string, input: DeviceInput) => Promise<DeviceResult>
    /** `canForce` — агент на машине отозвать не удалось; удалить можно только осознанно. */
    remove: (
      id: string,
      opts?: { force?: boolean }
    ) => Promise<{ ok: boolean; error?: string; canForce?: boolean }>
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
    /** `canForce` — агент на машине отозвать не удалось; удалить можно только осознанно. */
    remove: (
      id: string,
      opts?: { force?: boolean }
    ) => Promise<{ ok: boolean; error?: string; canForce?: boolean }>
  }
  accounts: {
    list: () => Promise<FinanceAccount[]>
    create: (input: FinanceAccountInput) => Promise<FinanceAccount>
    update: (id: string, input: FinanceAccountInput) => Promise<FinanceAccount>
    remove: (id: string) => Promise<{ ok: boolean }>
    setCreds: (
      id: string,
      creds: { apiKey?: string; secret?: string; passphrase?: string }
    ) => Promise<{ ok: boolean; error?: string }>
    refresh: () => Promise<{ updated: number; failed: number }>
    bankLogin: (bank: string) => Promise<{ ok: boolean; error?: string }>
    bankSession: (bank: string) => Promise<{ logged: boolean }>
  }
  wallets: {
    list: () => Promise<Wallet[]>
    create: (input: WalletInput) => Promise<Wallet>
    update: (id: string, input: WalletInput) => Promise<Wallet>
    /** `canForce` — агент на машине отозвать не удалось; удалить можно только осознанно. */
    remove: (
      id: string,
      opts?: { force?: boolean }
    ) => Promise<{ ok: boolean; error?: string; canForce?: boolean }>
    balance: (chain: string, address: string) => Promise<WalletBalance>
  }
  metrics: {
    history: (deviceId: string, limit?: number) => Promise<MetricSnapshot[]>
    live: (
      deviceId: string
    ) => Promise<{
      ok: boolean
      state: 'live' | 'unavailable' | 'unreachable'
      family: string
      os: string
      metrics: LiveMetrics | null
    }>
  }
  ai: {
    list: () => Promise<AiAccess[]>
    create: (input: AiAccessInput) => Promise<AiAccess>
    update: (id: string, input: AiAccessInput) => Promise<AiAccess>
    remove: (id: string) => Promise<{ ok: boolean }>
    check: (id: string) => Promise<AiCheck>
    checks: () => Promise<
      Array<{
        accessId: string
        status: string
        remaining: number | null
        usage: number | null
        detail: string | null
        checkedAt: number
        lastOkAt: number | null
      }>
    >
    quotas: () => Promise<AiQuotaSlice[]>
    prices: (provider?: string) => Promise<AiPrice[]>
    priceCount: () => Promise<number>
    refreshPrices: (accessId?: string) => Promise<{ ok: boolean; count: number; error?: string }>
    models: (accessId: string) => Promise<AiAccessModel[]>
    fetchModels: (accessId: string) => Promise<{ ok: boolean; total?: number; added: number; removed?: number; error?: string }>
    fetchModelsAll: () => Promise<{ ok: boolean; updated: number; total: number }>
    setModel: (model: AiAccessModel) => Promise<{ ok: boolean }>
    deleteModel: (accessId: string, model: string) => Promise<{ ok: boolean }>
    usage: (since?: string) => Promise<AiUsageSummary>
    collect: () => Promise<{ files: number; records: number; duplicates: number; unpriced: string[] }>
    setAccountSecret: (
      accessId: string,
      email: string,
      patch: { password?: string; apiKey?: string }
    ) => Promise<{ ok: boolean; error?: string }>
    copyAccountPassword: (accessId: string, email: string) => Promise<{ ok: boolean; error?: string }>
    checkAccountKey: (accessId: string, email: string) => Promise<AiCheck>
    importPasswords: (accessId: string) => Promise<{ ok: boolean; imported: number; added?: number; error?: string }>
    importPasswordsAll: () => Promise<{ ok: boolean; imported: number; added: number; error?: string }>
    onUpdated: (cb: (p: { reason: string }) => void) => () => void
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
  alerts: {
    list: () => Promise<Array<{
      key: string
      kind: string
      title: string
      body: string
      severity: 'warning' | 'critical'
      deviceId?: string
    }>>
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
    /** Рабочий стол отрисовался: до этого введённый пароль в хранилище не попадает. */
    confirmPassword: (handle: string) => Promise<{ ok: boolean }>
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
    /** `revoked`: remote — снят с машины; pending — она не в сети и агент на ней жив;
     *  failed — дошли, но снять не удалось. `ok: true` бывает только при 'remote'. */
    forget: (
      deviceId: string
    ) => Promise<{ ok: boolean; revoked: 'remote' | 'pending' | 'failed'; error?: string }>
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
      status: 'online' | 'offline' | 'unknown'
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
