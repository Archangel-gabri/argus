// Renderer-only lifetime; main owns its separate access-epoch and actual resource lockdown.
// A concealed renderer cannot start work. Old tickets never become valid after a new unlock.
let epoch = 0
let active = false

export function captureSession(): number | null {
  return active ? epoch : null
}

export function isSessionCurrent(ticket: number | null): boolean {
  return active && ticket !== null && ticket === epoch
}

/** Repeated acknowledged state refreshes do not cancel current-session work. */
export function activateSession(): void {
  if (active) return
  epoch += 1
  active = true
}

/** Call synchronously before clearing stores or awaiting a main-process lock reply. */
export function invalidateSession(): void {
  epoch += 1
  active = false
}
