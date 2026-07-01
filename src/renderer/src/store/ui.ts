import { create } from 'zustand'
import type { DeviceDTO } from '@/types'

export type ViewId = 'dashboard' | 'devices' | 'banks' | 'subscriptions' | 'streaming' | 'ai'

export type DialogState = { mode: 'closed' } | { mode: 'new' } | { mode: 'edit'; device: DeviceDTO }

interface UIState {
  view: ViewId
  search: string
  dialog: DialogState
  setView: (v: ViewId) => void
  setSearch: (s: string) => void
  openCreate: () => void
  openEdit: (device: DeviceDTO) => void
  closeDialog: () => void
  terminal: DeviceDTO | null
  openTerminal: (device: DeviceDTO) => void
  closeTerminal: () => void
  palette: boolean
  setPalette: (open: boolean) => void
  sshImport: 'ssh' | 'tailscale' | false
  setSshImport: (v: 'ssh' | 'tailscale' | false) => void
  sftp: DeviceDTO | null
  openSftp: (device: DeviceDTO) => void
  closeSftp: () => void
  broadcast: boolean
  setBroadcast: (open: boolean) => void
  forwards: DeviceDTO | null
  openForwards: (device: DeviceDTO) => void
  closeForwards: () => void
}

export const useUI = create<UIState>((set) => ({
  view: 'devices',
  search: '',
  dialog: { mode: 'closed' },
  setView: (view) => set({ view }),
  setSearch: (search) => set({ search }),
  openCreate: () => set({ dialog: { mode: 'new' } }),
  openEdit: (device) => set({ dialog: { mode: 'edit', device } }),
  closeDialog: () => set({ dialog: { mode: 'closed' } }),
  terminal: null,
  openTerminal: (terminal) => set({ terminal }),
  closeTerminal: () => set({ terminal: null }),
  palette: false,
  setPalette: (palette) => set({ palette }),
  sshImport: false,
  setSshImport: (sshImport) => set({ sshImport }),
  sftp: null,
  openSftp: (sftp) => set({ sftp }),
  closeSftp: () => set({ sftp: null }),
  broadcast: false,
  setBroadcast: (broadcast) => set({ broadcast }),
  forwards: null,
  openForwards: (forwards) => set({ forwards }),
  closeForwards: () => set({ forwards: null })
}))
