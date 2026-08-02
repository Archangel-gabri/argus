// Настоящий OpenSSH в контейнере — проверка договорённости с реальной реализацией.
//
// Встроенный поддельный sshd (fake-sshd.ts) незаменим для отказов, которые не воспроизвести:
// принять команду и не закрыть поток, оборвать соединение на третьем байте. Но он же и
// соглашается со всем, что мы делаем, потому что написан нами. Здесь наоборот: поведение
// диктует чужая реализация, и расхождения видно сразу.
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface SshdContainer {
  name: string
  /** Порт на loopback, куда проброшен sshd контейнера. */
  port: number
  user: string
  password: string
  /** Адрес контейнера во внутренней сети docker — по нему ходит вторая нога jump-схемы. */
  internalIp: (network?: string) => Promise<string>
  /** Выполнить команду внутри контейнера (настройка стенда, не проверяемый путь). */
  inside: (cmd: string) => Promise<string>
  stop: () => void
}

export const dockerAvailable = (): boolean => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const IMAGE = 'linuxserver/openssh-server:latest'
const USER = 'argus'
// Пароль стенда: словарный и заведомо ненастоящий, чтобы сканер секретов не принимал его за живой.
const PASSWORD = 'test-container-password'

let seq = 0

/** Диагностика подъёма стенда: без неё непонятно, что именно висит — docker или сам sshd. */
const log = (m: string): void => {
  if (process.env.ARGUS_DOCKER_DEBUG === '1') console.error('[docker-sshd]', m)
}

/** Поднять контейнер с sshd и дождаться, пока он начнёт отвечать баннером. */
export async function startSshd(
  opts: { network?: string; publish?: boolean } = {}
): Promise<SshdContainer> {
  const publish = opts.publish !== false
  const name = `argus-test-sshd-${process.pid}-${seq++}`
  const args = [
    'run', '-d', '--rm', '--name', name,
    '-e', 'PUID=1000', '-e', 'PGID=1000', '-e', 'TZ=Etc/UTC',
    '-e', `USER_NAME=${USER}`, '-e', `USER_PASSWORD=${PASSWORD}`,
    '-e', 'PASSWORD_ACCESS=true', '-e', 'SUDO_ACCESS=false'
  ]
  // Не публиковать порт — единственный способ сделать машину «доступной только через бастион»
  // честно: во внутреннюю сеть docker хост не маршрутизируется.
  if (publish) args.push('-p', '0:2222')
  if (opts.network) args.push('--network', opts.network)
  args.push(IMAGE)
  const t0 = Date.now()
  await exec('docker', args)
  log(`${name}: run ${Date.now() - t0}мс`)

  let port = 0
  if (publish) {
    const { stdout } = await exec('docker', ['port', name, '2222/tcp'])
    port = Number(stdout.trim().split('\n')[0].split(':').pop())
    log(`${name}: порт ${port}`)
    if (!Number.isInteger(port) || port <= 0)
      throw new Error(`не удалось прочитать порт: ${JSON.stringify(stdout)}`)
  }

  const container: SshdContainer = {
    name,
    port,
    user: USER,
    password: PASSWORD,
    internalIp: async (network?: string) => {
      const fmt = network
        ? `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`
        : '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'
      const r = await exec('docker', ['inspect', '-f', fmt, name])
      return r.stdout.trim().split(/\s+/)[0]
    },
    inside: async (cmd) => (await exec('docker', ['exec', name, 'sh', '-lc', cmd])).stdout,
    stop: () => {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
      } catch {
        /* уже остановлен */
      }
    }
  }

  if (publish) {
    const tb = Date.now()
    await waitForBanner(port)
    log(`${name}: баннер через ${Date.now() - tb}мс`)
  } else {
    // Снаружи не достучаться — ждём готовности по журналу самого контейнера.
    await waitForLog(name, 'sshd is listening')
    log(`${name}: sshd поднялся (по журналу)`)
  }
  return container
}

/** Ждём именно баннер SSH: открытый порт ещё не означает готовый sshd. */
async function waitForBanner(port: number, timeoutMs = 45_000): Promise<void> {
  const net = await import('node:net')
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let last = 'нет попыток'
  while (Date.now() < deadline) {
    attempt++
    const outcome = await new Promise<string>((resolve) => {
      const s = new net.Socket()
      let settled = false
      const done = (v: string): void => {
        if (settled) return
        settled = true
        s.destroy()
        resolve(v)
      }
      s.setTimeout(2000)
      s.once('data', (b: Buffer) =>
        done(b.toString('latin1').startsWith('SSH-') ? 'ok' : `чужой баннер: ${b.toString('latin1').slice(0, 20)}`)
      )
      s.once('error', (e: Error) => done(`ошибка: ${e.message}`))
      s.once('timeout', () => done('таймаут сокета'))
      s.once('close', () => done('закрыт без данных'))
      s.connect({ host: '127.0.0.1', port })
    })
    last = outcome
    log(`порт ${port}, попытка ${attempt}: ${outcome}`)
    if (outcome === 'ok') return
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new Error(`sshd на порту ${port} не поднялся за ${timeoutMs} мс (последнее: ${last})`)
}

/**
 * Разрешить бастиону пробрасывать соединения дальше.
 *
 * Образ linuxserver/openssh-server задуман как конечная точка для оболочки и файлов, поэтому
 * ставит `AllowTcpForwarding no`. Бастион без проброса — не бастион, и без этой правки схема
 * падала бы с «Channel open failure», хотя наш код при этом полностью исправен.
 */
export const allowTcpForwarding = async (container: string): Promise<void> => {
  // Действующий конфиг — /config/sshd/sshd_config (именно он в командной строке sshd), а не
  // /etc/ssh/sshd_config. И правим ЗАМЕНОЙ строки: у sshd действует ПЕРВОЕ вхождение ключа,
  // поэтому дописывание в конец ничего бы не изменило.
  await exec('docker', [
    'exec', container, 'sh', '-lc',
    "for f in /config/sshd/sshd_config /etc/ssh/sshd_config; do " +
      "[ -f \"$f\" ] && sed -i 's/^[[:space:]]*AllowTcpForwarding.*/AllowTcpForwarding yes/' \"$f\"; done; " +
      'pkill -HUP sshd.pam 2>/dev/null || pkill -HUP sshd 2>/dev/null || true'
  ])
  // Перечитывание конфига по сигналу занимает мгновение, но не мгновенно.
  await new Promise((r) => setTimeout(r, 1200))
}

/** Может ли САМ хост достучаться до адреса — предпосылка «доступно только через бастион». */
export const hostCanReach = async (host: string, port: number, timeoutMs = 4000): Promise<boolean> => {
  const net = await import('node:net')
  return new Promise<boolean>((resolve) => {
    const s = new net.Socket()
    let settled = false
    const done = (v: boolean): void => {
      if (settled) return
      settled = true
      s.destroy()
      resolve(v)
    }
    s.setTimeout(timeoutMs)
    // Слушаем и close тоже: docker умеет принять соединение и тут же закрыть его, и без этого
    // обработчика промис не разрешался бы никогда.
    s.once('data', () => done(true))
    s.once('error', () => done(false))
    s.once('timeout', () => done(false))
    s.once('close', () => done(false))
    s.connect({ host, port })
  })
}

export const createNetwork = async (name: string, internal = false): Promise<void> => {
  const args = ['network', 'create']
  if (internal) args.push('--internal')
  args.push(name)
  await exec('docker', args).catch(() => undefined)
}

/** Подключить уже запущенный контейнер во вторую сеть — так бастион виден и снаружи, и внутри. */
export const connectNetwork = async (network: string, container: string): Promise<void> => {
  await exec('docker', ['network', 'connect', network, container])
}

/** Готовность по журналу — для машин без опубликованного порта. */
async function waitForLog(name: string, needle: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { stdout, stderr } = await exec('docker', ['logs', name]).catch(() => ({ stdout: '', stderr: '' }))
    if (`${stdout}${stderr}`.includes(needle)) return
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new Error(`${name}: в журнале не появилось «${needle}» за ${timeoutMs} мс`)
}
export const removeNetwork = (name: string): void => {
  try {
    execFileSync('docker', ['network', 'rm', name], { stdio: 'ignore' })
  } catch {
    /* сеть уже удалена или занята */
  }
}
