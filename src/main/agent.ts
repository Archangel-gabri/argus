// Провижининг и жизненный цикл собственного агента трансляции (см. agent/ в этом репозитории).
//
// Смысл агента: RDP требует пароль учётной записи ОС и существует только на Windows. Агент
// ставится по SSH — а SSH-доступ уже доказывает контроль над машиной, — получает от Argus
// одноразово сгенерированный токен, и пароль ОС из цепочки исчезает. Один протокол на все ОС.
//
// Здесь только установка/проверка. Сам поток идёт напрямую из окна экрана к агенту.
import crypto from 'node:crypto'
import https from 'node:https'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { execOnce, resolveConn } from './ssh'
import { whichOs } from './pc'
import { getAgentToken, setAgentToken, getAgentCert, setAgentCert } from './vault'
import { buildForgetCommand, decideForgetOutcome, type ForgetOutcome } from './agent-forget'
import { remoteFamily, remoteArch } from './os-family'
import { hostForUrl } from './ip-privacy'
import { interpretWindowsService, interpretHealth } from './agent-health'

export const AGENT_PORT = 47990
const AGENT_VERSION = '0.1.0'

export interface AgentStatus {
  installed: boolean
  running: boolean
  version?: string
  os?: string
  error?: string
  /**
   * Агент отвечает, но его версия не совпадает с ожидаемой. Раньше версия просто пересылалась
   * наверх и ни с чем не сверялась: агент старого протокола объявлялся рабочим, окно
   * трансляции открывалось, и разваливалось всё уже на разборе кадров — далеко от причины.
   */
  outdated?: boolean
  /** Чего не хватает, человеческим языком (нет ffmpeg, нет прав на /dev/uinput …). */
  detail?: string
}

/** Каталог с бинарями агента: в собранном приложении — resources/agent, в dev — из репозитория. */
function agentDir(): string {
  const packed = path.join(process.resourcesPath || '', 'agent')
  if (fs.existsSync(packed)) return packed
  return path.join(app.getAppPath(), 'resources', 'agent')
}

function binaryFor(family: string, arch: string): string | null {
  const name =
    family === 'windows'
      ? 'argus-agent-windows-amd64.exe'
      : family === 'darwin'
        ? `argus-agent-darwin-${arch}`
        : `argus-agent-linux-${arch}`
  const p = path.join(agentDir(), name)
  return fs.existsSync(p) ? p : null
}

export interface DarwinTargetPaths {
  dir: string
  bin: string
  token: string
  cert: string
}

/** На macOS явно переопределяем Go-default и держим все файлы агента в одном каталоге. */
export function darwinTargetPaths(home: string): DarwinTargetPaths {
  if (!home.startsWith('/') || /[\r\n]/.test(home)) throw new Error('домашний каталог macOS должен быть абсолютным')
  const dir = path.posix.join(home, '.argus')
  return {
    dir,
    bin: path.posix.join(dir, 'argus-agent'),
    token: path.posix.join(dir, 'agent.token'),
    cert: path.posix.join(dir, 'agent.crt')
  }
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
/** Одинарные кавычки PowerShell экранируются УДВОЕНИЕМ, а не обратной косой. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`
const xmlText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const DARWIN_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

/** LaunchAgent обязан содержать абсолютные пути: launchd не разворачивает ни `~`, ни `$HOME`. */
export function buildDarwinLaunchAgent(p: DarwinTargetPaths): string {
  const bin = xmlText(p.bin)
  const token = xmlText(p.token)
  const dir = xmlText(p.dir)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.argus.agent</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProgramArguments</key><array>
<string>${bin}</string><string>--addr</string><string>0.0.0.0:${AGENT_PORT}</string>
<string>--token-file</string><string>${token}</string><string>--cert-dir</string><string>${dir}</string>
</array>
<key>WorkingDirectory</key><string>${dir}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xmlText(path.posix.dirname(p.dir))}</string><key>PATH</key><string>${DARWIN_PATH}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>`
}

/** Атомарно публикуем plist и работаем с современным gui/<uid> bootstrap-domain. */
export function buildDarwinInstallCommand(p: DarwinTargetPaths, uid: string): string {
  if (!/^\d+$/.test(uid)) throw new Error('UID macOS не распознан')
  const launchDir = path.posix.join(path.posix.dirname(p.dir), 'Library', 'LaunchAgents')
  const plistPath = path.posix.join(launchDir, 'com.argus.agent.plist')
  const tmpPath = `${plistPath}.new`
  const domain = `gui/${uid}`
  const job = `${domain}/com.argus.agent`
  return [
    `mkdir -p ${shellQuote(launchDir)}`,
    `cat > ${shellQuote(tmpPath)} <<'PLIST'\n${buildDarwinLaunchAgent(p)}\nPLIST`,
    `chmod 600 ${shellQuote(tmpPath)} && mv -f ${shellQuote(tmpPath)} ${shellQuote(plistPath)}`,
    `launchctl bootout ${shellQuote(job)} >/dev/null 2>&1 || true`,
    `launchctl bootstrap ${shellQuote(domain)} ${shellQuote(plistPath)}`,
    `launchctl kickstart -k ${shellQuote(job)}`,
    `launchctl print ${shellQuote(job)} >/dev/null`,
    'echo ok'
  ].join('\n')
}

/** Selftest идёт в bootstrap GUI-пользователя, а не в отдельном SSH StandardIO-сеансе. */
export function buildDarwinSelftestCommand(p: DarwinTargetPaths, uid: string): string {
  if (!/^\d+$/.test(uid)) throw new Error('UID macOS не распознан')
  const home = path.posix.dirname(p.dir)
  return `launchctl asuser ${shellQuote(uid)} /usr/bin/env ${shellQuote(`HOME=${home}`)} ${shellQuote(`PATH=${DARWIN_PATH}`)} ${shellQuote(p.bin)} --selftest 2>&1`
}

/** Отпечаток SHA-256 от DER сертификата — единый формат для всех сторон (нижний hex). */
export function fingerprintFromPem(pem: string): string {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')
}

// Закреплённые сертификаты по хостам — читает проверка сертификатов Electron (см. index.ts).
// Отдельная карта, потому что проверка вызывается синхронно и ходить в БД оттуда нельзя.
const pinnedByHost = new Map<string, string>()

export function pinHost(host: string, pem: string): void {
  pinnedByHost.set(host, fingerprintFromPem(pem))
}

/** Совпадает ли предъявленный сертификат с закреплённым для этого хоста. */
export function certPinMatches(host: string, pem: string): boolean {
  const want = pinnedByHost.get(host)
  if (!want) return false
  return fingerprintFromPem(pem) === want
}

/** Пины нужны только пока vault разблокирован и открывается экран. */
export function clearPinnedHosts(): void {
  pinnedByHost.clear()
}

/**
 * HTTPS-запрос к агенту.
 *
 * Проверка TLS ОСТАЁТСЯ ВКЛЮЧЁННОЙ. Публичного центра сертификации у машины нет, поэтому
 * доверенным корнем выступает сам закреплённый сертификат агента — тот, что мы прочитали
 * по SSH при установке. Это настоящий пиннинг: подменённый сертификат не пройдёт проверку,
 * и токен уйти чужому серверу не успеет.
 * Проверку ИМЕНИ хоста отключаем осознанно: обращаемся по IP, а он у машины меняется —
 * личность подтверждает сам сертификат, а не адрес.
 */
function agentHTTP(host: string, token: string, pinnedPem: string | null, timeoutMs = 4000): Promise<AgentStatus> {
  return new Promise((resolve) => {
    if (!pinnedPem) {
      resolve({ installed: false, running: false, error: 'сертификат агента не закреплён — переустанови агент' })
      return
    }
    // Токен — заголовком, не в URL: строка запроса попадает в логи по всему пути.
    const req = https.get(
      {
        host,
        port: AGENT_PORT,
        path: '/health',
        timeout: timeoutMs,
        headers: { 'X-Argus-Token': token },
        ca: [pinnedPem],
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            const j = JSON.parse(body) as { ok?: boolean; version?: string; os?: string; error?: string }
            // Версия теперь сверяется, а не просто пересылается наверх. Иначе агент старого
            // протокола объявлялся рабочим, окно трансляции открывалось, и всё разваливалось
            // уже на разборе кадров — далеко от причины.
            const v = interpretHealth(j, AGENT_VERSION)
            resolve({ ...v, os: j.os })
          } catch {
            resolve({ installed: false, running: false, error: 'агент ответил неразборчиво' })
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ installed: false, running: false, error: 'агент не отвечает' })
    })
    req.on('error', (e) => resolve({ installed: false, running: false, error: e.message }))
  })
}

/** Жив ли агент на устройстве (без установки). */
export async function agentStatus(deviceId: string): Promise<AgentStatus> {
  const token = getAgentToken(deviceId)
  if (!token) return { installed: false, running: false, error: 'агент ещё не устанавливался' }
  const cert = getAgentCert(deviceId)
  const conn = await resolveConn(deviceId)
  if (!conn) return { installed: false, running: false, error: 'устройство не в сети' }
  if (cert) pinHost(conn.host, cert)
  return agentHTTP(conn.host, token, cert)
}

/** PowerShell в один вызов, безопасно относительно кавычек и кодировок. */
function psCmd(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

export interface ProvisionResult {
  ok: boolean
  step?: string
  error?: string
  status?: AgentStatus
  /** Отчёт самотеста агента: что реально работает на этой машине. */
  selftest?: string
  /**
   * Установка удалась, но с оговоркой — например, смотреть можно, а управлять нельзя.
   * Отдельно от error намеренно: это не отказ, и показывать его как отказ было бы неправдой.
   */
  warning?: string
}

/**
 * Установка агента: заливаем бинарь, кладём токен, поднимаем автозапуск, прогоняем самотест.
 *
 * Намеренно НЕ считаем установку успешной по факту «команды выполнились»: критерий — агент
 * ответил по сети и его самотест показал, что захват реально отдаёт кадры. Иначе получилось бы
 * ровно то враньё, от которого мы уже избавлялись в питании.
 */
export async function provisionAgent(deviceId: string): Promise<ProvisionResult> {
  const os = await whichOs(deviceId)
  if (os.family === 'off') return { ok: false, step: 'связь', error: 'устройство не в сети' }
  const conn = await resolveConn(deviceId)
  if (!conn) return { ok: false, step: 'связь', error: 'не удалось определить адрес' }

  // Архитектуру И семейство спрашиваем у самой машины.
  //
  // Так надо, потому что whichOs различает всего две семьи: всё, что не Windows, считается Linux.
  // Из-за этого сюда НИКОГДА не приезжал 'darwin' — заливался linux-бинарь, а ветка установки
  // через launchd была недостижимым кодом. То есть заявленная поддержка macOS не работала бы,
  // и выяснилось бы это только у пользователя.
  const archProbe =
    os.family === 'windows'
      ? await execOnce(deviceId, psCmd('$env:PROCESSOR_ARCHITECTURE'))
      : await execOnce(deviceId, 'uname -s; uname -m')
  const raw = (archProbe.output || '').trim().toLowerCase()
  // Неизвестность прекращает установку ДО заливки файла. Раньше пустой ответ молча означал
  // «linux/amd64»: на Windows- или arm-машину заливался чужой бинарь и затирал рабочий, а
  // диагноз приходил позже и в другом месте.
  if (!archProbe.ok || !raw)
    return {
      ok: false,
      step: 'платформа',
      error: `не удалось определить ОС и архитектуру машины: ${archProbe.error || 'пустой ответ'}`
    }
  const arch = remoteArch(raw)
  const family = remoteFamily(os.family === 'windows', raw)

  if (family === 'freebsd')
    return {
      ok: false,
      step: 'платформа',
      error: 'для FreeBSD агент пока не собирается — доступен запасной путь через терминал'
    }

  const bin = binaryFor(family, arch)
  if (!bin) return { ok: false, step: 'бинарь', error: `нет собранного агента под ${family}/${arch}` }

  const token = getAgentToken(deviceId) || crypto.randomBytes(32).toString('hex')

  // 1. Каталог
  const mk =
    family === 'windows'
      ? await execOnce(deviceId, psCmd(`New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\\Argus" | Out-Null; 'ok'`))
      : await execOnce(deviceId, `mkdir -p "$HOME/.argus" && chmod 700 "$HOME/.argus" && echo ok`)
  if (!mk.ok) return { ok: false, step: 'каталог', error: mk.error || mk.output }

  // 2. Бинарь (SFTP)
  const up = await uploadFile(deviceId, bin, family === 'windows' ? 'argus-agent.exe' : 'argus-agent', family)
  if (!up.ok) return { ok: false, step: 'загрузка агента', error: up.error }

  // 3. Токен — напрямую по SFTP с mode 0600. Раньше значение встраивалось в удалённую
  // shell/PowerShell-команду: комментарий обещал обратное, а секрет можно было вытащить из
  // process listing или ScriptBlock logging. Теперь командная строка значения не видит.
  const tokWrite = await writeTokenFile(deviceId, family, token)
  if (!tokWrite.ok) return { ok: false, step: 'токен', error: tokWrite.error }

  // 3.5 Проба запуска. Отдельным шагом — чтобы упереться здесь с внятной причиной, а не
  //     позже с загадочным «exit 1» от следующей команды.
  const canRun = await checkCanRun(deviceId, family)
  if (!canRun.ok) return { ok: false, step: 'запуск агента', error: canRun.error }

  // 4. Сертификат: агент создаёт его сам при первом обращении, а мы забираем ПО SSH —
  //    то есть по уже доверенному каналу. Это и есть момент закрепления (TOFU).
  const certRead =
    family === 'windows'
      ? await execOnce(
          deviceId,
          psCmd(
            `& "$env:LOCALAPPDATA\\Argus\\argus-agent.exe" --fingerprint | Out-Null; ` +
              `Get-Content -Raw "$env:LOCALAPPDATA\\Argus\\agent.crt"`
          )
        )
      : await execOnce(
          deviceId,
          `"$HOME/.argus/argus-agent" --token-file "$HOME/.argus/agent.token" --cert-dir "$HOME/.argus" --fingerprint >/dev/null 2>&1; cat "$HOME/.argus/agent.crt"`
        )
  const pem = (certRead.output || '').trim()
  if (!/BEGIN CERTIFICATE/.test(pem))
    return { ok: false, step: 'сертификат', error: 'агент не отдал сертификат: ' + (certRead.error || pem).slice(0, 200) }

  // 5. Автозапуск
  const svc = await installService(deviceId, family)
  if (!svc.ok) return { ok: false, step: 'автозапуск', error: svc.error }

  // 5. Самотест — единственный честный критерий «работает»
  const st =
    family === 'windows'
      ? await execOnce(deviceId, psCmd(`& "$env:LOCALAPPDATA\\Argus\\argus-agent.exe" --selftest 2>&1 | Out-String`))
      : family === 'darwin' && svc.darwin
        ? await execOnce(deviceId, buildDarwinSelftestCommand(svc.darwin.paths, svc.darwin.uid))
        : await execOnce(deviceId, `"$HOME/.argus/argus-agent" --selftest 2>&1`)

  setAgentToken(deviceId, token)
  setAgentCert(deviceId, pem)
  pinHost(conn.host, pem)
  const status = await agentHTTP(conn.host, token, pem, 6000)
  const selftest = (st.output || '').trim()
  const captureOK = /захват: РАБОТАЕТ/.test(selftest)
  // Управление мышью и клавиатурой есть не везде: на macOS инъекция ввода требует cgo, а агент
  // собирается без него сознательно — ради одного файла на платформу. Сказать об этом надо
  // СРАЗУ после установки, а не оставлять человека выяснять опытным путём, почему курсор
  // не двигается. Просмотр при этом работает полностью.
  const controlOK = /управление: есть/.test(selftest)

  return {
    ok: status.running && captureOK,
    status,
    selftest,
    // Отсутствие управления — не ошибка установки, поэтому это предупреждение, а не error.
    warning:
      status.running && captureOK && !controlOK
        ? 'Смотреть можно, управлять — нет: на этой системе агент не может вводить мышь и клавиатуру.'
        : undefined,
    error: status.running
      ? captureOK
        ? undefined
        : 'агент установлен и отвечает, но захват экрана на этой машине не заработал (см. самотест)'
      : status.error || 'агент установлен, но не отвечает по сети'
  }
}

/** Записать token через уже доверенный SSH/SFTP-канал, ни разу не подставляя его в команду. */
async function writeTokenFile(
  deviceId: string,
  family: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  const { sftpOpen, sftpWriteFile, sftpClose } = await import('./sftp')
  const s = await sftpOpen(deviceId)
  if (!s.ok || !s.sessionId) return { ok: false, error: s.error || 'sftp не открылся' }
  try {
    const home = await execOnce(
      deviceId,
      family === 'windows' ? psCmd('$env:LOCALAPPDATA') : 'printf %s "$HOME"'
    )
    const base = (home.output || '').trim()
    if (!base) return { ok: false, error: 'не удалось определить домашний каталог' }
    const remote = family === 'windows' ? `${base}\\Argus\\agent.token` : `${base}/.argus/agent.token`
    const written = await sftpWriteFile(s.sessionId, remote, token, 0o600)
    if (!written.ok) return written
    if (family === 'windows') {
      // SFTP mode не задаёт Windows DACL. Ужимаем ACL отдельной командой БЕЗ значения токена.
      const acl = await execOnce(
        deviceId,
        psCmd(
          `$p="$env:LOCALAPPDATA\\Argus\\agent.token"; $acl=Get-Acl $p; ` +
            `$acl.SetAccessRuleProtection($true,$false); ` +
            `$r=New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME,'FullControl','Allow'); ` +
            `$acl.SetAccessRule($r); Set-Acl $p $acl; 'ok'`
        )
      )
      if (!acl.ok) return { ok: false, error: acl.error || 'не удалось ограничить ACL токена' }
    }
    return { ok: true }
  } finally {
    sftpClose(s.sessionId)
  }
}

/**
 * Проверка, что залитый бинарь вообще МОЖЕТ быть запущен.
 *
 * На Windows 11 со включённым Smart App Control неподписанные программы блокируются политикой
 * ещё до выполнения кода — и любая следующая команда падает с бессмысленным «exit 1».
 * Поэтому пробуем `--version` и, если не вышло, спрашиваем систему о причине, чтобы вернуть
 * пользователю не код возврата, а то, что реально произошло, и что с этим делать.
 */
async function checkCanRun(deviceId: string, family: string): Promise<{ ok: boolean; error?: string }> {
  const probe =
    family === 'windows'
      ? await execOnce(deviceId, psCmd(`& "$env:LOCALAPPDATA\\Argus\\argus-agent.exe" --version 2>&1 | Out-String`))
      : await execOnce(deviceId, `"$HOME/.argus/argus-agent" --version 2>&1`)

  if (probe.ok && /argus-agent/i.test(probe.output)) return { ok: true }

  if (family === 'windows') {
    const sac = await execOnce(
      deviceId,
      psCmd(
        `(Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy" -EA 0).VerifiedAndReputablePolicyState`
      )
    )
    // 1 = включён и применяется, 2 = режим оценки (тоже может блокировать).
    // Ищем построчно: PowerShell подмешивает в вывод служебный CLIXML, и строгое
    // совпадение по всему тексту не срабатывало — проверено на живой машине.
    const sacOn = (sac.output || '')
      .split('\n')
      .map((l) => l.trim())
      .some((l) => l === '1' || l === '2')
    if (sacOn) {
      return {
        ok: false,
        error:
          'Windows Smart App Control заблокировал агент: он пропускает только подписанные или уже известные ' +
          'облачной репутации Microsoft программы, а наш бинарь неподписанный. Исключения для отдельного файла ' +
          'эта политика не предусматривает. Что можно сделать: (1) перевести Smart App Control в режим оценки ' +
          'или выключить — Безопасность Windows → Управление приложениями и браузером; начиная с обновления ' +
          'от апреля 2026 его можно включить обратно без переустановки Windows; (2) подписать агент ' +
          'сертификатом от центра из доверенного списка Microsoft — тогда он работает при включённом SAC; ' +
          '(3) ничего не менять и пользоваться запасным путём через RDP, ему агент не нужен.'
      }
    }
  }
  const detail = (probe.output || probe.error || '').trim().slice(0, 300)
  return { ok: false, error: `агент не запускается на машине: ${detail || 'причина неизвестна'}` }
}

interface DarwinContext {
  paths: DarwinTargetPaths
  uid: string
}

interface InstallServiceResult {
  ok: boolean
  error?: string
  darwin?: DarwinContext
}

async function readDarwinContext(deviceId: string): Promise<DarwinContext | { error: string }> {
  const r = await execOnce(deviceId, `printf '%s\\n%s\\n' "$HOME" "$(id -u)"`)
  if (!r.ok) return { error: r.output || r.error || 'не удалось определить GUI-пользователя macOS' }
  const [home = '', uid = ''] = r.output.split(/\r?\n/)
  try {
    return { paths: darwinTargetPaths(home.trim()), uid: uid.trim() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const linuxUnit = `[Unit]
Description=Argus screen agent
After=graphical-session.target

[Service]
ExecStart=%h/.argus/argus-agent --addr 0.0.0.0:${AGENT_PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`

/**
 * Linger — часть критерия установки, а не внешняя рекомендация: без него user-unit проходит
 * immediate health, но исчезает после logout/reboot. Пытаемся включить без второго вопроса и
 * затем обязательно перечитываем факт у logind.
 */
export function buildLinuxInstallCommand(): string {
  return [
    'LINGER=$(loginctl show-user "$USER" -P Linger 2>/dev/null || true)',
    'if [ "$LINGER" != yes ]; then',
    '  sudo -n loginctl enable-linger "$USER" >/dev/null 2>&1 || true',
    '  LINGER=$(loginctl show-user "$USER" -P Linger 2>/dev/null || true)',
    'fi',
    '[ "$LINGER" = yes ] || { echo LINGER_NOT_ENABLED; exit 1; }',
    'mkdir -p "$HOME/.config/systemd/user"',
    `cat > "$HOME/.config/systemd/user/argus-agent.service" <<'UNIT'\n${linuxUnit}UNIT`,
    'systemctl --user daemon-reload',
    'systemctl --user enable argus-agent.service',
    'systemctl --user restart argus-agent.service',
    // uinput остаётся best-effort и проверяется самотестом: просмотр не должен падать вместе с вводом.
    `{ sudo -n sh -c 'modprobe uinput; usermod -aG input '"$USER"'; printf %s "KERNEL==\\"uinput\\", GROUP=\\"input\\", MODE=\\"0660\\"\\n" > /etc/udev/rules.d/99-argus-uinput.rules; udevadm control --reload-rules; udevadm trigger' >/dev/null 2>&1 || true; }`,
    // Доказательство вместо слова «ok».
    //
    // Раньше последней строкой стоял безусловный `echo ok`, а `set -e` здесь нет — и код
    // возврата всей команды брался от него. То есть провалившийся `systemctl --user` (самый
    // частый случай: в exec-сессии без XDG_RUNTIME_DIR он не находит шину пользователя)
    // давал exit 0, и установка объявлялась успешной при неподнятой службе.
    //
    // Хуже всего это на ПЕРЕустановке поверх работающего агента: новый бинарь уже положен,
    // но не запущен, а на /health отвечает старый процесс — с тем же сертификатом и той же
    // версией. Проверка готовности проходит, человеку сказано «установлено», и агент
    // исчезает после ближайшей перезагрузки.
    'systemctl --user is-active --quiet argus-agent.service || { echo ARGUS_SVC_INACTIVE; exit 1; }',
    'systemctl --user is-enabled --quiet argus-agent.service || { echo ARGUS_SVC_DISABLED; exit 1; }',
    'echo ARGUS_SVC_OK'
  ].join('\n')
}

/** Автозапуск: systemd --user на Linux, launchd на macOS, планировщик задач на Windows. */
async function installService(
  deviceId: string,
  family: string
): Promise<InstallServiceResult> {
  if (family === 'windows') {
    // Задача в планировщике с триггером на вход в систему: процесс живёт в ИНТЕРАКТИВНОЙ сессии
    // пользователя. Служба здесь не годится — она попадает в сессию 0, где нет рабочего стола,
    // и захватывать было бы нечего.
    // Порт агента открываем ТОЛЬКО для диапазона Tailscale. Агент слушает 0.0.0.0 (иначе он не
    // виден в tailnet), а значит без этого правила он торчал бы и в локальную сеть — где трафик
    // идёт без шифрования и сосед по Wi-Fi мог бы снять токен вместе с экраном и управлением.
    // Скрипт заканчивается ПРОВЕРКОЙ, а не словом 'ok'. Без $ErrorActionPreference='Stop'
    // отказ New-NetFirewallRule или Register-ScheduledTask по правам — не-прерывающая ошибка:
    // скрипт доходил до конца, печатал 'ok', выходил с нулём, и установка объявлялась успешной
    // без обещанного правила firewall и без автозапуска. Если при этом на машине ещё жил старый
    // процесс агента, то и последующая проба здоровья подтверждала «всё хорошо».
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `$exe="$env:LOCALAPPDATA\\Argus\\argus-agent.exe"`,
      `try {`,
      `if(-not(Get-NetFirewallRule -DisplayName 'Argus agent tailnet' -EA SilentlyContinue)){`,
      `New-NetFirewallRule -DisplayName 'Argus agent tailnet' -Direction Inbound -Protocol TCP ` +
        `-LocalPort ${AGENT_PORT} -RemoteAddress 100.64.0.0/10 -Action Allow|Out-Null}`,
      `$a=New-ScheduledTaskAction -Execute $exe -Argument '--addr 0.0.0.0:${AGENT_PORT}';`,
      `$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;`,
      `$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew;`,
      `Register-ScheduledTask -TaskName 'ArgusAgent' -Action $a -Trigger $t -Settings $s -Force -RunLevel Highest | Out-Null;`,
      `Start-ScheduledTask -TaskName 'ArgusAgent'`,
      `} catch { Write-Output "ARGUS_SVC_ERR=$($_.Exception.Message)" }`,
      `Start-Sleep -Seconds 2`,
      // Читаем фактическое состояние — и только оно решает.
      `$task=if(Get-ScheduledTask -TaskName 'ArgusAgent' -EA SilentlyContinue){1}else{0}`,
      `$fw=if(Get-NetFirewallRule -DisplayName 'Argus agent tailnet' -EA SilentlyContinue){1}else{0}`,
      `Write-Output "ARGUS_SVC_TASK=$task"`,
      `Write-Output "ARGUS_SVC_FW=$fw"`,
      `Write-Output 'ARGUS_SVC_DONE'`
    ].join(';')
    const r = await execOnce(deviceId, psCmd(ps))
    const v = interpretWindowsService(r.output, r.ok)
    return v.ok ? { ok: true } : { ok: false, error: v.error || r.error || r.output }
  }

  if (family === 'darwin') {
    const context = await readDarwinContext(deviceId)
    if ('error' in context) return { ok: false, error: context.error }
    const r = await execOnce(deviceId, buildDarwinInstallCommand(context.paths, context.uid))
    return r.ok ? { ok: true, darwin: context } : { ok: false, error: r.output || r.error }
  }

  const r = await execOnce(deviceId, buildLinuxInstallCommand())
  if (r.ok && /ARGUS_SVC_OK/.test(r.output)) return { ok: true }
  if (/ARGUS_SVC_INACTIVE/.test(r.output))
    return {
      ok: false,
      error:
        'служба агента не запустилась через systemd --user. Обычная причина — недоступная шина ' +
        'пользователя в неинтерактивном сеансе SSH (нет XDG_RUNTIME_DIR).'
    }
  if (/ARGUS_SVC_DISABLED/.test(r.output))
    return { ok: false, error: 'служба агента запущена, но не включена в автозапуск — после перезагрузки её не будет' }
  if (/LINGER_NOT_ENABLED/.test(r.output)) {
    return {
      ok: false,
      error: 'не удалось включить linger: без него агент остановится после выхода пользователя. Нужен passwordless sudo для loginctl enable-linger.'
    }
  }
  return { ok: false, error: r.output || r.error }
}

/** Заливка файла в каталог агента по SFTP (переиспользуем ssh-соединение устройства). */
async function uploadFile(
  deviceId: string,
  localPath: string,
  remoteName: string,
  family: string
): Promise<{ ok: boolean; error?: string }> {
  const { sftpOpen, sftpPutFile, sftpClose } = await import('./sftp')
  const s = await sftpOpen(deviceId)
  if (!s.ok || !s.sessionId) return { ok: false, error: s.error || 'sftp не открылся' }
  try {
    // Домашний каталог на той стороне резолвим сами: SFTP не разворачивает $HOME/%LOCALAPPDATA%.
    const home = await execOnce(
      deviceId,
      family === 'windows' ? psCmd('$env:LOCALAPPDATA') : 'printf %s "$HOME"'
    )
    const base = (home.output || '').trim()
    if (!base) return { ok: false, error: 'не удалось определить домашний каталог' }
    // Пишем во ВРЕМЕННОЕ имя и переименовываем поверх.
    //
    // Прямая запись в файл работающего агента невозможна: ядро держит файл запущенной программы
    // и отвечает «текстовый файл занят», а по SFTP это приходит невнятным «Failure». Именно на
    // этом падала повторная установка — самый частый случай, обновление уже работающего агента.
    // Переименование же атомарно и старому процессу не мешает: он продолжает жить со своей
    // копией, а новое имя сразу указывает на свежий файл.
    const dir = family === 'windows' ? `${base}\\Argus` : `${base}/.argus`
    const sep = family === 'windows' ? '\\' : '/'
    const remote = `${dir}${sep}${remoteName}`
    const tmp = `${remote}.new`
    const r = await sftpPutFile(s.sessionId, localPath, tmp)
    if (!r.ok) return { ok: false, error: r.error }
    if (family === 'windows') {
      // На Windows переименование поверх существующего файла не проходит, а запущенный
      // исполняемый файл переименовать МОЖНО — поэтому сначала уводим старый в сторону.
      const mv = await execOnce(
        deviceId,
        psCmd(
          // Путь приходит из %LOCALAPPDATA% чужой машины. Апостроф в имени пользователя
          // (`C:\Users\D'Artagnan\...`) закрывал бы литерал раньше времени и превращал
          // остаток пути в исполняемый код — поэтому подстановка идёт через psQuote.
          `$t=${psQuote(remote)}; $n=${psQuote(tmp)}; if (Test-Path $t) { Move-Item -Force $t "$t.old" -EA SilentlyContinue }; ` +
            `Move-Item -Force $n $t; Remove-Item "$t.old" -Force -EA SilentlyContinue; 'ok'`
        )
      )
      if (!mv.ok) return { ok: false, error: mv.error || 'не удалось заменить файл агента' }
    } else {
      const mv = await execOnce(deviceId, `mv -f "${remote}.new" "${remote}" && chmod 755 "${remote}"`)
      if (!mv.ok) return { ok: false, error: mv.error || 'не удалось заменить файл агента' }
    }
    return { ok: true }
  } finally {
    sftpClose(s.sessionId)
  }
}

/**
 * Забыть агента ПОЛНОСТЬЮ — вместе с его учётными файлами на самой машине.
 *
 * Раньше «забыть» стирало только запись в хранилище. Агент на машине оставался вместе со своим
 * сертификатом и токеном, и повторная установка их переиспользовала — то есть «переустановить»
 * не чинило ровно тех поломок, ради которых его и нажимают. Живой пример: сертификат, выписанный
 * при сбитых часах, оставался негодным после того, как часы починили.
 *
 * Сам двоичный файл не трогаем: он будет перезаписан установкой, а удалять работающую программу
 * ради выдачи новых ключей незачем.
 */
export async function forgetAgent(
  deviceId: string
): Promise<{ ok: boolean; revoked: ForgetOutcome['revoked']; error?: string }> {
  // Порядок обратный прежнему и это главное в этой функции. Раньше локальный токен стирался
  // ПЕРВЫМ: обрыв посередине оставлял на машине живой агент с действующим токеном, а у нас —
  // ничего, чем его отозвать. Теперь токен уходит последним и только после подтверждения.
  const os = await whichOs(deviceId)

  if (os.family === 'off') {
    const out = decideForgetOutcome({ family: 'off', execOk: false, output: '' })
    return { ok: out.ok, revoked: out.revoked, error: out.ok ? undefined : out.error }
  }

  // Семейство спрашиваем у машины, а не у `whichOs`: тот знает только Windows и «всё остальное»,
  // и на macOS отзыв ушёл бы по linux-ветке, не тронув launchd — а он поднял бы агент заново.
  const probe =
    os.family === 'windows'
      ? { output: '' }
      : await execOnce(deviceId, 'uname -s; uname -m')
  const family = remoteFamily(os.family === 'windows', probe.output)

  let darwinJob: string | undefined
  if (family === 'darwin') {
    const ctx = await readDarwinContext(deviceId)
    if (!('error' in ctx)) darwinJob = `gui/${ctx.uid}/com.argus.agent`
  }

  const raw = buildForgetCommand(family, darwinJob)
  const r = await execOnce(deviceId, family === 'windows' ? psCmd(raw) : raw)
  const out = decideForgetOutcome({
    family,
    execOk: r.ok,
    output: r.output,
    error: r.error
  })

  // Забываем у себя ТОЛЬКО когда отзыв подтверждён с той стороны. Иначе токен нужен нам
  // самим — чтобы проверить состояние и повторить попытку.
  if (out.ok) {
    setAgentToken(deviceId, null)
    setAgentCert(deviceId, null)
  }
  return { ok: out.ok, revoked: out.revoked, error: out.ok ? undefined : out.error }
}

/** Данные для подключения окна экрана к агенту. */
export async function agentEndpoint(
  deviceId: string
): Promise<{ ok: boolean; url?: string; token?: string; error?: string }> {
  const token = getAgentToken(deviceId)
  if (!token) return { ok: false, error: 'агент не установлен' }
  const cert = getAgentCert(deviceId)
  if (!cert) return { ok: false, error: 'сертификат агента не закреплён — переустанови агент' }
  const conn = await resolveConn(deviceId)
  if (!conn) return { ok: false, error: 'устройство не в сети' }
  // Закрепляем ДО открытия окна: проверка сертификата в Electron сработает раньше,
  // чем renderer успеет что-либо отправить.
  pinHost(conn.host, cert)
  // Литерал IPv6 в URL обязан быть в квадратных скобках, иначе двоеточия адреса сливаются с
  // разделителем порта: `wss://fd00::1:47990/stream` — не адрес, `new URL` бросает Invalid URL.
  return { ok: true, url: `wss://${hostForUrl(conn.host)}:${AGENT_PORT}/stream`, token }
}

export { AGENT_VERSION }
