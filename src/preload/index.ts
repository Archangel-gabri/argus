import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// Sandboxed preload: only `electron` builtins are available — no npm requires.
// Secrets never come BACK across this bridge; the renderer sends actions and
// receives secret-free DTOs / terminal bytes only.
const api = {
  vault: {
    state: () => ipcRenderer.invoke('vault:state'),
    initialize: (password: string) => ipcRenderer.invoke('vault:initialize', password),
    unlock: (password: string) => ipcRenderer.invoke('vault:unlock', password),
    lock: () => ipcRenderer.invoke('vault:lock'),
    changePassword: (current: string, next: string) =>
      ipcRenderer.invoke('vault:changePassword', current, next)
  },
  devices: {
    list: () => ipcRenderer.invoke('devices:list'),
    create: (input: unknown) => ipcRenderer.invoke('devices:create', input),
    update: (id: string, input: unknown) => ipcRenderer.invoke('devices:update', id, input),
    remove: (id: string) => ipcRenderer.invoke('devices:delete', id)
  },
  ssh: {
    open: (deviceId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('ssh:open', deviceId, cols, rows),
    input: (sessionId: string, data: string) => ipcRenderer.send('ssh:input', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    close: (sessionId: string) => ipcRenderer.send('ssh:close', sessionId),
    probe: (deviceId: string) => ipcRenderer.invoke('ssh:probe', deviceId),
    probeHost: (opts: {
      host: string
      port: number
      user: string
      password: string
      privateKey?: string
      passphrase?: string
    }) => ipcRenderer.invoke('ssh:probeHost', opts),
    exec: (deviceId: string, command: string) => ipcRenderer.invoke('ssh:exec', deviceId, command),
    forgetHostKey: (host: string, port: number) =>
      ipcRenderer.invoke('ssh:forgetHostKey', host, port),
    onData: (cb: (p: { sessionId: string; data: string }) => void) => {
      const h = (_e: IpcRendererEvent, p: { sessionId: string; data: string }): void => cb(p)
      ipcRenderer.on('ssh:data', h)
      return () => ipcRenderer.removeListener('ssh:data', h)
    },
    onExit: (cb: (p: { sessionId: string }) => void) => {
      const h = (_e: IpcRendererEvent, p: { sessionId: string }): void => cb(p)
      ipcRenderer.on('ssh:exit', h)
      return () => ipcRenderer.removeListener('ssh:exit', h)
    }
  },
  sshconfig: {
    parse: () => ipcRenderer.invoke('sshconfig:parse'),
    import: (hosts: unknown) => ipcRenderer.invoke('sshconfig:import', hosts)
  },
  sftp: {
    open: (deviceId: string) => ipcRenderer.invoke('sftp:open', deviceId),
    list: (sessionId: string, path: string) => ipcRenderer.invoke('sftp:list', sessionId, path),
    download: (sessionId: string, path: string) => ipcRenderer.invoke('sftp:download', sessionId, path),
    upload: (sessionId: string, remoteDir: string) => ipcRenderer.invoke('sftp:upload', sessionId, remoteDir),
    remove: (sessionId: string, path: string, isDir: boolean) =>
      ipcRenderer.invoke('sftp:delete', sessionId, path, isDir),
    close: (sessionId: string) => ipcRenderer.send('sftp:close', sessionId)
  },
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    create: (name: string, command: string) => ipcRenderer.invoke('snippets:create', name, command),
    remove: (id: string) => ipcRenderer.invoke('snippets:delete', id)
  },
  discovery: {
    tailscale: () => ipcRenderer.invoke('discovery:tailscale')
  },
  subs: {
    list: () => ipcRenderer.invoke('subs:list'),
    create: (input: unknown) => ipcRenderer.invoke('subs:create', input),
    update: (id: string, input: unknown) => ipcRenderer.invoke('subs:update', id, input),
    remove: (id: string) => ipcRenderer.invoke('subs:delete', id)
  },
  wallets: {
    list: () => ipcRenderer.invoke('wallets:list'),
    create: (input: unknown) => ipcRenderer.invoke('wallets:create', input),
    remove: (id: string) => ipcRenderer.invoke('wallets:delete', id),
    balance: (chain: string, address: string) => ipcRenderer.invoke('wallets:balance', chain, address)
  },
  metrics: {
    history: (deviceId: string, limit?: number) => ipcRenderer.invoke('metrics:history', deviceId, limit ?? 30)
  },
  ai: {
    list: () => ipcRenderer.invoke('ai:list'),
    create: (input: unknown) => ipcRenderer.invoke('ai:create', input),
    remove: (id: string) => ipcRenderer.invoke('ai:delete', id),
    check: (id: string) => ipcRenderer.invoke('ai:check', id)
  },
  forward: {
    open: (deviceId: string, localPort: number, remoteHost: string, remotePort: number) =>
      ipcRenderer.invoke('forward:open', deviceId, localPort, remoteHost, remotePort),
    list: (deviceId: string) => ipcRenderer.invoke('forward:list', deviceId),
    close: (id: string) => ipcRenderer.send('forward:close', id)
  },
  assist: {
    parseDevice: (text: string) => ipcRenderer.invoke('assist:parseDevice', text)
  },
  net: {
    ipLookup: (ip: string) => ipcRenderer.invoke('net:ipLookup', ip)
  },
  pc: {
    whichOs: (deviceId: string) => ipcRenderer.invoke('pc:whichOs', deviceId),
    metrics: (deviceId: string) => ipcRenderer.invoke('pc:metrics', deviceId),
    boot: (deviceId: string, targetOs: string) => ipcRenderer.invoke('pc:boot', deviceId, targetOs),
    power: (deviceId: string, action: 'reboot' | 'poweroff' | 'suspend') =>
      ipcRenderer.invoke('pc:power', deviceId, action)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore — contextIsolation is on; this branch is a safety fallback only
  window.api = api
}
