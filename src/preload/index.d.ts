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
  AiCheck
} from '../main/types'
import type { ParsedHost } from '../main/sshconfig'
import type { SftpEntry } from '../main/sftp'
import type { ForwardInfo } from '../main/forward'

export type VaultResult = { ok: boolean; error?: string; state: VaultState }
export type DeviceResult = { ok: boolean; error?: string; device?: DeviceDTO }
export type ProbeResult = {
  ok: boolean
  status: 'online' | 'offline'
  cpu?: number
  ramUsed?: number
  ramTotal?: number
  error?: string
}

export interface NexusApi {
  vault: {
    state: () => Promise<VaultState>
    initialize: (password: string) => Promise<VaultResult>
    unlock: (password: string) => Promise<VaultResult>
    lock: () => Promise<VaultState>
  }
  devices: {
    list: () => Promise<DeviceDTO[]>
    create: (input: DeviceInput) => Promise<DeviceResult>
    update: (id: string, input: DeviceInput) => Promise<DeviceResult>
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  ssh: {
    open: (deviceId: string, cols: number, rows: number) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
    input: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    close: (sessionId: string) => void
    probe: (deviceId: string) => Promise<ProbeResult>
    exec: (deviceId: string, command: string) => Promise<{ ok: boolean; output: string; error?: string }>
    probeHost: (opts: { host: string; port: number; user: string; password: string }) => Promise<{
      ok: boolean
      os?: string
      hostname?: string
      cores?: number
      cpu?: number
      ramUsed?: number
      ramTotal?: number
      error?: string
    }>
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
    remove: (id: string) => Promise<{ ok: boolean }>
    balance: (chain: string, address: string) => Promise<WalletBalance>
  }
  metrics: {
    history: (deviceId: string, limit?: number) => Promise<MetricSnapshot[]>
  }
  ai: {
    list: () => Promise<AiAccount[]>
    create: (input: AiAccountInput) => Promise<AiAccount>
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
}

declare global {
  interface Window {
    api: NexusApi
  }
}

export {}
