import { create } from 'zustand'

/**
 * Видимые сообщения о результате действий.
 *
 * Зачем это понадобилось. Линтер, включённый на этом проходе, нашёл 68 обработчиков вида
 * `onClick={async () => { await api.что-то() }}`: если вызов отклонён, промис некому поймать,
 * ошибка уходит в «unhandled rejection» — и человек не видит НИЧЕГО. Он нажал, ничего не
 * произошло, и остаётся гадать: сорвалось или просто медленно.
 *
 * Для приложения, которое перезагружает чужие серверы и распоряжается деньгами, «нажал и
 * ничего» — худший из возможных ответов. Поэтому у каждого действия теперь есть видимый исход.
 *
 * Сообщения намеренно живут в отдельном хранилище, а не в UI-состоянии: они переживают закрытие
 * диалога, в котором произошёл отказ. Иначе сообщение об ошибке исчезало бы вместе с окном,
 * которое её вызвало, — ровно в тот момент, когда его надо прочитать.
 */
export type ToastKind = 'error' | 'success' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  text: string
  /** Подробность (текст ошибки от main). Показывается мельче, но не прячется. */
  detail?: string
  createdAt: number
}

/** Сколько держать на экране. Ошибку — дольше: её надо успеть прочитать и осмыслить. */
export const TOAST_TTL_MS: Record<ToastKind, number> = {
  error: 12_000,
  success: 4_000,
  info: 6_000
}

/** Больше пяти одновременно — это уже не сообщение, а шум, который перестают читать. */
const MAX_VISIBLE = 5

interface ToastState {
  toasts: Toast[]
  push: (kind: ToastKind, text: string, detail?: string) => string
  dismiss: (id: string) => void
  clear: () => void
}

let seq = 0
const nextId = (): string => `t${++seq}`

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, text, detail) => {
    const id = nextId()
    const toast: Toast = { id, kind, text, detail, createdAt: Date.now() }
    set((s) => {
      // Повтор того же текста не плодит строки, а обновляет существующую: иначе пять неудачных
      // опросов одного хоста дают пять одинаковых сообщений и вытесняют всё остальное.
      const same = s.toasts.find((t) => t.kind === kind && t.text === text && t.detail === detail)
      if (same) return { toasts: s.toasts.map((t) => (t === same ? { ...t, createdAt: toast.createdAt } : t)) }
      return { toasts: [...s.toasts, toast].slice(-MAX_VISIBLE) }
    })
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] })
}))

/** Короткие обёртки — чтобы вызов на месте читался одной строкой. */
export const toastError = (text: string, detail?: string): string => useToasts.getState().push('error', text, detail)
export const toastSuccess = (text: string): string => useToasts.getState().push('success', text)
