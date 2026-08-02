/** Все живые возможности, которые обязана отозвать блокировка приложения. */
export interface LockdownActions {
  revokePending: () => void
  closeScreens: () => void
  closeSsh: () => void
  closeSftp: () => void
  closeForwards: () => void
  clearAgentPins: () => void
  clearAlerts: () => void
  /** Забыть склейки одновременных опросов: начатое до блокировки не должно отвечать после. */
  clearInFlight: () => void
  /** Забыть серии промахов живости: новая сессия считает «не знаю» с чистого листа. */
  clearReachMemory: () => void
  lockVault: () => void
}

/** Порядок важен: доступы закрываются, пока vault ещё открыт, и только потом закрывается БД. */
export function runLockdown(actions: LockdownActions): void {
  // Каждый cleanup best-effort и изолирован. Один уже сломанный SSH client не должен
  // помешать закрыть экран, localhost-listener и сам vault.
  const steps = [
    actions.revokePending,
    actions.closeScreens,
    actions.closeSsh,
    actions.closeSftp,
    actions.closeForwards,
    actions.clearAgentPins,
    actions.clearAlerts,
    actions.clearInFlight,
    actions.clearReachMemory,
    actions.lockVault
  ]
  for (const step of steps) {
    try {
      step()
    } catch {
      /* продолжаем отзывать остальные возможности */
    }
  }
}
