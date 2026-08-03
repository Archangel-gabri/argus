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
/** Отложенная первая проверка. Хранится отдельно, потому что гасить её надо тоже. */
let firstCheck: ReturnType<typeof setTimeout> | null = null
let last: Alert[] = []

/** Текущие тревоги — их показывает интерфейс, чтобы не полагаться только на уведомления. */
export function currentAlerts(): Alert[] {
  return last
}

/** После lock не отдаём renderer имена устройств/подписок из последнего снимка. */
export function clearAlerts(): void {
  last = []
  memory.update([])
}

function check(): void {
  // Хранилище заперто — читать нечего, и будить человека тоже нечем.
  if (!isUnlocked()) return

  const devices = listDevices().map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    // Старый диск остаётся в UI с отметкой времени, но сторож не будит по устаревшему замеру.
    disk: d.metricsFresh ? (d.disk ?? null) : null,
    lastSeen: d.lastSeen ?? null
  }))
  const subscriptions = listSubscriptions().map((s) => ({
    id: s.id,
    name: s.name,
    provider: s.provider,
    nextRenewal: s.nextRenewal,
    manualRenewal: s.manualRenewal
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
  //
  // Дескриптор отложенной проверки надо сохранить. Раньше он выбрасывался, и `stopWatchdog`
  // гасил только интервал: отложенная проверка всё равно срабатывала — уже после остановки,
  // а на выходе из приложения ещё и после блокировки хранилища.
  //
  // Интервал взводится ВНУТРИ первой проверки, а не рядом с ней. Иначе отсрочка бессмысленна:
  // интервал в 60 секунд срабатывал раньше отложенных 90 и приносил ровно ту пачку ложных
  // тревог, ради избавления от которой отсрочка и сделана.
  if (firstCheck) return
  firstCheck = setTimeout(() => {
    firstCheck = null
    check()
    timer = setInterval(check, CHECK_EVERY_MS)
  }, 90_000)
}

export function stopWatchdog(): void {
  if (firstCheck) clearTimeout(firstCheck)
  if (timer) clearInterval(timer)
  firstCheck = null
  timer = null
}
