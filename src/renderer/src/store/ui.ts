import { create } from 'zustand'
import type { DeviceDTO } from '@/types'

export type ViewId = 'devices' | 'banks' | 'subscriptions' | 'ai' | 'settings'

export type DialogState = { mode: 'closed' } | { mode: 'new' } | { mode: 'edit'; device: DeviceDTO }

export type DrawerTab = 'overview' | 'terminal' | 'files' | 'forwards' | 'metrics' | 'screen'

interface UIState {
  view: ViewId
  search: string
  dialog: DialogState
  setView: (v: ViewId) => void
  setSearch: (s: string) => void
  openCreate: () => void
  openEdit: (device: DeviceDTO) => void
  closeDialog: () => void
  /** Детальный drawer устройства (грани: обзор/терминал/файлы/порты/метрики). */
  detail: { device: DeviceDTO; tab: DrawerTab } | null
  openDetail: (device: DeviceDTO, tab?: DrawerTab) => void
  closeDetail: () => void
  setDetailTab: (tab: DrawerTab) => void
  /** Шорткаты-грани: сохраняют старые сигнатуры для карточки/палитры. */
  openTerminal: (device: DeviceDTO) => void
  openSftp: (device: DeviceDTO) => void
  openForwards: (device: DeviceDTO) => void
  palette: boolean
  setPalette: (open: boolean) => void
  sshImport: 'ssh' | 'tailscale' | false
  setSshImport: (v: 'ssh' | 'tailscale' | false) => void
  broadcast: boolean
  setBroadcast: (open: boolean) => void
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
  detail: null,
  openDetail: (device, tab = 'overview') => set({ detail: { device, tab } }),
  closeDetail: () => set({ detail: null }),
  setDetailTab: (tab) => set((s) => (s.detail ? { detail: { ...s.detail, tab } } : {})),
  openTerminal: (device) => set({ detail: { device, tab: 'terminal' } }),
  openSftp: (device) => set({ detail: { device, tab: 'files' } }),
  openForwards: (device) => set({ detail: { device, tab: 'forwards' } }),
  palette: false,
  setPalette: (palette) => set({ palette }),
  sshImport: false,
  setSshImport: (sshImport) => set({ sshImport }),
  broadcast: false,
  setBroadcast: (broadcast) => set({ broadcast })
}))
