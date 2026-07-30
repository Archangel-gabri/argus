// Сторож: раз в минуту читает уже собранное состояние и, если что-то не так, говорит об этом
// уведомлением системы — не дожидаясь, пока откроют приложение.
//
// Ничего не опрашивает сам. Данные о машинах поступают из обычного цикла (живость раз в 10
// секунд, полный опрос раз в 30), подписки лежат в хранилище. Сторож только читает и делает
// вывод — поэтому он не может ни нагрузить сеть, ни помешать работе.
//
// Правила и подавление повторов живут в alerts.ts и покрыты проверками; здесь остаётся
// расписание, доступ к данным и показ уведомления.

import { Notification } from 'electron'
import { evaluateAlerts, AlertMemory, type Alert } from './alerts'
import { listDevices, listSubscriptions, isUnlocked } from './vault'

/** Как часто смотреть. Чаще незачем: полный опрос машин и так идёт раз в 30 секунд. */
const CHECK_EVERY_MS = 60_000

const memory = new AlertMemory()
let timer: ReturnType<typeof setInterval> | null = null
let last: Alert[] = []

/** Текущие тревоги — их показывает интерфейс, чтобы не полагаться только на уведомления. */
export function currentAlerts(): Alert[] {
  return last
}

function check(): void {
  // Хранилище заперто — читать нечего, и будить человека тоже нечем.
  if (!isUnlocked()) return

  const devices = listDevices().map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    disk: d.disk ?? null,
    lastSeen: d.lastSeen ?? null
  }))
  const subscriptions = listSubscriptions().map((s) => ({
    id: s.id,
    name: s.name,
    provider: s.provider,
    nextRenewal: s.nextRenewal,
    // Признака «продление ручное» в записи подписки нет, а напоминать обо ВСЕХ нельзя:
    // автосписание само себя не забудет, и лишние уведомления приучают их не читать.
    // Поэтому владелец отмечает такие подписки словом в заметке — это его решение, а не
    // догадка приложения. Временное решение, пока у подписки не появится отдельное поле.
    manual: /ручн/i.test(s.notes ?? '')
  }))

  last = evaluateAlerts({ devices, subscriptions, now: Date.now() })
  const { fresh } = memory.update(last)

  for (const a of fresh) {
    if (!Notification.isSupported()) break
    new Notification({
      title: a.title,
      body: a.body,
      // Срочные показываем сразу, остальные не должны перебивать работу.
      urgency: a.severity === 'critical' ? 'critical' : 'normal'
    }).show()
  }
}

/** Запустить сторожа. Первая проверка — с задержкой: на старте состояние ещё не собрано. */
export function startWatchdog(): void {
  if (timer) return
  // Ждём первый полный цикл опроса: иначе на старте все машины «не отвечают» просто потому,
  // что их ещё не спрашивали, и владелец получит пачку ложных тревог при каждом запуске.
  setTimeout(check, 90_000)
  timer = setInterval(check, CHECK_EVERY_MS)
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer)
  timer = null
}
