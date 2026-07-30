// Поколение main-owned доступов. Lock увеличивает его синхронно; любая асинхронная операция,
// начатая до lock, проверяет билет перед регистрацией ресурса и не может открыть его заново.
let epoch = 0

export function beginAccess(): number {
  return epoch
}

export function isAccessCurrent(ticket: number): boolean {
  return ticket === epoch
}

export function revokePendingAccess(): void {
  epoch++
}
