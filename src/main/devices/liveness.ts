// Быстрая проверка «жив ли хост» — ОТДЕЛЬНО от метрик.
//
// Зачем: полный SSH-опрос стоит 1.6–4с на сервер (рукопожатие + аутентификация + скрипт), а для
// точки «онлайн/офлайн» хватает одного round-trip. Замер до этого: 70 секунд от входа в приложение
// до появления статусов.
//
// ВАЖНО, проверено на живом стенде: голого TCP-коннекта НЕДОСТАТОЧНО. Когда на машине поднят VPN
// в режиме fake-ip TUN, коннект успешно «устанавливается» к ЛЮБОМУ адресу — выключенный сервер
// показывался онлайн, причём у всех хостов был подозрительно одинаковый отклик 125мс.
// Поэтому ждём SSH-баннер («SSH-2.0-…»), который шлёт настоящий sshd сразу после коннекта:
// стоит те же один round-trip, но подделать его туннель не может.
import net from 'node:net'
import tls from 'node:tls'
import { getOsEndpoints, getDeviceConn, listDevices } from '../vault/vault'
import { consumeSshBanner, type Reachability } from '../../shared/reachability'

/**
 * Отказ, случившийся НА НАШЕЙ стороне: до чужой машины дело не дошло.
 *
 * `ENETUNREACH`/`ENETDOWN` — нет маршрута или интерфейс лёг; `EAI_AGAIN`/`ENOTFOUND` — не
 * ответил DNS (при пропаже сети это самый частый исход); `EHOSTUNREACH` оставляем в отказах
 * машины: его присылает маршрутизатор, то есть сеть у нас есть.
 */
const localFailure = (code?: string): boolean =>
  code === 'ENETUNREACH' || code === 'ENETDOWN' || code === 'EAI_AGAIN' || code === 'ENOTFOUND'

/**
 * Что доказывает отказ.
 *
 * `ECONNREFUSED` — машина ответила пакетом «порт закрыт». Это доказательство, что она РАБОТАЕТ:
 * сетевой стек жив, лёг только sshd или переехал порт. Раньше такой ответ засчитывался в
 * «Выключен» наравне с молчанием, и владелец шёл разбираться с питанием вместо службы.
 *
 * Молчание (таймаут, сброс, обрыв) — единственный случай, когда «выключено» правдоподобно, и
 * даже он объявляется только после серии промахов.
 */
function verdictFor(code?: string): Reachability {
  if (localFailure(code)) return 'unknown'
  if (code === 'ECONNREFUSED') return 'unknown'
  return 'offline'
}

export interface Reach {
  status: Reachability
  ms: number
}

/**
 * Бюджет одной проверки живости.
 *
 * Замерено на парке владельца 2026-08-06: баннер от нью-йоркской ноды идёт 2.60–2.74 с, от
 * немецкой 2.43–2.67 с (через VPN-туннель в режиме fake-ip TUN, иначе было бы вдвое быстрее).
 * При прежних 4 секундах запас был 1.3 с, и его съедал любой всплеск задержки: та же нода,
 * которая при бюджете 15 с отвечала 4 раза из 4, при 4 с отвечала 4 из 5. То есть каждый пятый
 * «сервер не отвечает» приложение придумывало само.
 *
 * 8 секунд — троекратный запас к самому медленному настоящему ответу. Цена — упавшая машина
 * признаётся упавшей позже; это дешевле, чем мигающий статус, которому перестают верить.
 */
const REACH_BUDGET_MS = 8000

/** Коннект + ожидание SSH-баннера. Резолв DNS входит в бюджет. */
export function tcpAlive(host: string, port: number, timeoutMs = REACH_BUDGET_MS): Promise<Reach> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    if (!host || host.includes('x.x')) return resolve({ status: 'unknown', ms: 0 })
    // Порт вне диапазона — «не знаю»: мы ничего не проверили. Ноль сюда тоже попадает.
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return resolve({ status: 'unknown', ms: 0 })
    const sock = new net.Socket()
    let done = false
    let banner = ''
    const finish = (status: Reachability): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve({ status, ms: Date.now() - t0 })
    }
    sock.setTimeout(timeoutMs)
    // Коннект сам по себе НИЧЕГО не доказывает — ждём баннер. `data` не обязан содержать
    // целые четыре байта: в живом TCP поймано `SS` + `H-2.0...`.
    sock.on('data', (buf: Buffer) => {
      const next = consumeSshBanner(banner, buf.toString('latin1'))
      banner = next.text
      // Пришли байты, но это не SSH — на порту кто-то другой. Про питание машины это говорит
      // ОБРАТНОЕ «выключено»: она ответила. Утверждать «online» тоже нельзя (через fake-ip
      // туннель отвечает сам туннель), поэтому честный исход — «не знаю».
      if (next.verdict !== null) finish(next.verdict ? 'online' : 'unknown')
    })
    sock.once('timeout', () => finish('offline'))
    // Причина отказа решает, что мы вправе утверждать.
    //
    // «Отказано в соединении» и «хост недостижим» приходят ОТ СЕТИ: кто-то ответил, значит
    // машина правда не принимает подключение. А вот «сеть недоступна», «имя не разрешается» и
    // «DNS не отвечает» означают, что мы не вышли за пределы своего ноутбука, — про удалённую
    // машину это не говорит ничего.
    //
    // Раньше все отказы сваливались в один: стоило пропасть интернету, и весь парк через три
    // промаха объявлялся «Выключен». Владелец видел выключенными серверы, которые в это время
    // работали.
    sock.once('error', (e: NodeJS.ErrnoException) => finish(verdictFor(e.code)))
    // Если байты уже пришли, машина отвечает — что бы ни случилось дальше. Незавершённый
    // баннер («SS» без «H-2.0») с последующим закрытием раньше засчитывался в «выключено»,
    // хотя удалённая сторона только что прислала данные.
    sock.once('close', () => finish(banner.length > 0 ? 'unknown' : 'offline'))
    // Порт приходит из записи устройства, а её заполняет человек. Node на порту вне 1..65535
    // бросает СИНХРОННО (`ERR_SOCKET_BAD_PORT`), и этот бросок улетал наружу через Promise.all
    // в `deviceReach`/`fleetReach` — то есть одна кривая запись выключала обновление статусов у
    // ВСЕГО парка, навсегда до перезапуска, оставляя на карточках протухшее «Онлайн» как факт.
    // «Не знаю» здесь честнее «offline»: мы ничего не проверили.
    try {
      // Порт берём как есть: `port || 22` молча подменял ноль двадцать вторым, и запись с
      // явно неверным портом объявлялась живой по ЧУЖОМУ порту. Значение по умолчанию ставит
      // хранилище при создании записи — здесь догадываться не о чем.
      sock.connect({ host, port })
    } catch {
      finish('unknown')
    }
  })
}

/** Достижимо ли устройство хоть по одному из своих ОС-эндпоинтов (multi-boot ПК — по любому). */
export async function deviceReach(deviceId: string, timeoutMs = REACH_BUDGET_MS): Promise<Reach> {
  const eps = getOsEndpoints(deviceId)
  const conns = eps.length ? eps.map((e) => e.conn) : [getDeviceConn(deviceId)].filter((c) => c !== null)
  if (!conns.length) return { status: 'unknown', ms: 0 }
  // Хост за бастионом напрямую недостижим по определению: прямая TCP-проба всегда промахнётся
  // и пометила бы устройство мёртвым. Такие проверяем только полным опросом, который умеет
  // ходить туннелем, — а здесь честно говорим «не знаю», не роняя статус.
  if (conns.some((c) => c.jump)) return { status: 'unknown', ms: 0 }
  const results = await Promise.all(
    // Отказ пробы одного эндпоинта не должен ронять вердикт по устройству целиком.
    conns.map((c) =>
      tcpAlive(c.host, c.port, timeoutMs).catch((): Reach => ({ status: 'unknown', ms: 0 }))
    )
  )
  const alive = results.filter((r) => r.status === 'online')
  return alive.length
    ? { status: 'online', ms: Math.min(...alive.map((r) => r.ms)) }
    : results.every((r) => r.status === 'unknown')
      ? { status: 'unknown', ms: 0 }
      : { status: 'offline', ms: Math.max(...results.map((r) => r.ms)) }
}

/**
 * Есть ли у НАС выход в сеть.
 *
 * Спрашиваем только тогда, когда весь парк разом перестал отвечать, и только у публичных
 * распознавателей имён: до них доходит всё, что вообще выходит наружу, они не ведут журнал
 * посещений и не узнают из этого ничего о владельце. Один короткий TCP-коннект, без запроса.
 *
 * Проверяется ФАКТ СОЕДИНЕНИЯ, а не ответ. Первая версия звала `tcpAlive`, который ждёт
 * SSH-баннер, — но на 443-м порту баннера нет и не будет, поэтому проверка всегда упиралась в
 * таймаут и всегда отвечала «связи нет». Защита работала наоборот: упавший парк помечался бы
 * «не знаю» даже при живом интернете, и «выключен» не появился бы никогда.
 */
/**
 * Дошли ли мы до НАСТОЯЩЕГО сервера в интернете.
 *
 * Проверяется TLS-рукопожатие с проверкой имени в сертификате, а не факт соединения. Причина
 * записана в шапке этого же файла и была мной упущена: на машине владельца поднят туннель в
 * режиме fake-ip, и голый TCP-коннект успешно устанавливается к ЛЮБОМУ адресу. Проверено
 * замером: коннект к заведомо несуществующему `192.0.2.7:443` возвращает «успех». То есть
 * проверка по коннекту всегда отвечала бы «интернет есть» — ровно в той конфигурации, ради
 * которой она и писалась.
 *
 * Сертификат туннель подделать не может: для этого ему нужен закреплённый в системе чужой
 * удостоверяющий центр. Поэтому успешное рукопожатие с `cloudflare-dns.com` — доказательство,
 * что наружу мы выходим.
 */
function tlsHandshakeSucceeds(host: string, servername: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const sock = tls.connect({ host, port: 443, servername, rejectUnauthorized: true })
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('secureConnect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

async function internetReachable(): Promise<boolean> {
  const results = await Promise.all([
    tlsHandshakeSucceeds('1.1.1.1', 'cloudflare-dns.com', 4000),
    tlsHandshakeSucceeds('8.8.8.8', 'dns.google', 4000)
  ])
  return results.some(Boolean)
}

/** Разом по всему парку — параллельно. Именно это зовём сразу после входа в приложение. */
export async function fleetReach(timeoutMs = REACH_BUDGET_MS): Promise<Record<string, Reach>> {
  const devices = listDevices()
  const pairs = await Promise.all(
    // И то же на уровне парка: сломанная запись портит вердикт только о себе. Раньше её
    // исключение всплывало в обработчик IPC, где ловить было уже некому.
    devices.map(async (d) => {
      try {
        return [d.id, await deviceReach(d.id, timeoutMs)] as const
      } catch {
        return [d.id, { status: 'unknown', ms: 0 }] as const
      }
    })
  )
  // Весь парк отвалился разом — почти наверняка это наша сеть, а не одновременная смерть всех
  // машин. Проверяем и, если выхода наружу нет, ни про одну машину ничего не утверждаем: у
  // владельца при пропаже интернета все серверы объявлялись выключенными, хотя работали.
  //
  // Одна машина в парке — признака нет: её отказ ничем не отличается от отказа сети, и лишний
  // запрос наружу тут ничего не доказывает.
  const answered = pairs.filter(([, r]) => r.status !== 'unknown')
  if (answered.length > 1 && answered.every(([, r]) => r.status === 'offline')) {
    if (!(await internetReachable())) {
      return Object.fromEntries(pairs.map(([id, r]) => [id, r.status === 'offline' ? { status: 'unknown' as const, ms: r.ms } : r]))
    }
  }
  return Object.fromEntries(pairs)
}
