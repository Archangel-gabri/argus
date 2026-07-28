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

export const AGENT_PORT = 47990
const AGENT_VERSION = '0.1.0'

export interface AgentStatus {
  installed: boolean
  running: boolean
  version?: string
  os?: string
  error?: string
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

/** Пути на целевой машине. Namespace .argus / %LOCALAPPDATA%\Argus — чтобы ничего не засорять. */
function targetPaths(family: string): { dir: string; bin: string; token: string } {
  if (family === 'windows') {
    return {
      dir: '%LOCALAPPDATA%\\Argus',
      bin: '%LOCALAPPDATA%\\Argus\\argus-agent.exe',
      token: '%LOCALAPPDATA%\\Argus\\agent.token'
    }
  }
  return { dir: '$HOME/.argus', bin: '$HOME/.argus/argus-agent', token: '$HOME/.argus/agent.token' }
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
            resolve({ installed: true, running: !!j.ok, version: j.version, os: j.os, error: j.error })
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

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

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
  const arch = /arm64|aarch64/.test(raw) ? 'arm64' : 'amd64'
  const family =
    os.family === 'windows' ? 'windows' : /darwin/.test(raw) ? 'darwin' : /bsd/.test(raw) ? 'freebsd' : 'linux'

  if (family === 'freebsd')
    return {
      ok: false,
      step: 'платформа',
      error: 'для FreeBSD агент пока не собирается — доступен запасной путь через терминал'
    }

  const bin = binaryFor(family, arch)
  if (!bin) return { ok: false, step: 'бинарь', error: `нет собранного агента под ${family}/${arch}` }

  const p = targetPaths(family)
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

  // 3. Токен — файлом с правами только для владельца, не через командную строку
  //    (аргументы процесса видны всей системе в списке процессов).
  const tokWrite =
    family === 'windows'
      ? await execOnce(
          deviceId,
          psCmd(
            `Set-Content -Path "$env:LOCALAPPDATA\\Argus\\agent.token" -Value ${JSON.stringify(token)} -NoNewline -Encoding ascii; ` +
              `$acl=Get-Acl "$env:LOCALAPPDATA\\Argus\\agent.token"; $acl.SetAccessRuleProtection($true,$false); ` +
              `$r=New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME,'FullControl','Allow'); ` +
              `$acl.SetAccessRule($r); Set-Acl "$env:LOCALAPPDATA\\Argus\\agent.token" $acl; 'ok'`
          )
        )
      : await execOnce(
          deviceId,
          `umask 077 && printf %s ${shq(token)} > "$HOME/.argus/agent.token" && chmod 600 "$HOME/.argus/agent.token" && echo ok`
        )
  if (!tokWrite.ok) return { ok: false, step: 'токен', error: tokWrite.error || tokWrite.output }

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
          `"$HOME/.argus/argus-agent" --fingerprint >/dev/null 2>&1; cat "$HOME/.argus/agent.crt"`
        )
  const pem = (certRead.output || '').trim()
  if (!/BEGIN CERTIFICATE/.test(pem))
    return { ok: false, step: 'сертификат', error: 'агент не отдал сертификат: ' + (certRead.error || pem).slice(0, 200) }

  // 5. Автозапуск
  const svc = await installService(deviceId, family, p)
  if (!svc.ok) return { ok: false, step: 'автозапуск', error: svc.error }

  // 5. Самотест — единственный честный критерий «работает»
  const st =
    family === 'windows'
      ? await execOnce(deviceId, psCmd(`& "$env:LOCALAPPDATA\\Argus\\argus-agent.exe" --selftest 2>&1 | Out-String`))
      : await execOnce(deviceId, `"$HOME/.argus/argus-agent" --selftest 2>&1`)

  setAgentToken(deviceId, token)
  setAgentCert(deviceId, pem)
  pinHost(conn.host, pem)
  const status = await agentHTTP(conn.host, token, pem, 6000)
  const selftest = (st.output || '').trim()
  const captureOK = /захват: РАБОТАЕТ/.test(selftest)

  return {
    ok: status.running && captureOK,
    status,
    selftest,
    error: status.running
      ? captureOK
        ? undefined
        : 'агент установлен и отвечает, но захват экрана на этой машине не заработал (см. самотест)'
      : status.error || 'агент установлен, но не отвечает по сети'
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

/** Автозапуск: systemd --user на Linux, launchd на macOS, планировщик задач на Windows. */
async function installService(
  deviceId: string,
  family: string,
  p: { bin: string; token: string }
): Promise<{ ok: boolean; error?: string }> {
  if (family === 'windows') {
    // Задача в планировщике с триггером на вход в систему: процесс живёт в ИНТЕРАКТИВНОЙ сессии
    // пользователя. Служба здесь не годится — она попадает в сессию 0, где нет рабочего стола,
    // и захватывать было бы нечего.
    // Порт агента открываем ТОЛЬКО для диапазона Tailscale. Агент слушает 0.0.0.0 (иначе он не
    // виден в tailnet), а значит без этого правила он торчал бы и в локальную сеть — где трафик
    // идёт без шифрования и сосед по Wi-Fi мог бы снять токен вместе с экраном и управлением.
    const ps =
      `$exe="$env:LOCALAPPDATA\\Argus\\argus-agent.exe";` +
      `if(-not(Get-NetFirewallRule -DisplayName 'Argus agent tailnet' -EA 0)){` +
      `New-NetFirewallRule -DisplayName 'Argus agent tailnet' -Direction Inbound -Protocol TCP ` +
      `-LocalPort ${AGENT_PORT} -RemoteAddress 100.64.0.0/10 -Action Allow|Out-Null};` +
      `$a=New-ScheduledTaskAction -Execute $exe -Argument '--addr 0.0.0.0:${AGENT_PORT}';` +
      `$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;` +
      `$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew;` +
      `Register-ScheduledTask -TaskName 'ArgusAgent' -Action $a -Trigger $t -Settings $s -Force -RunLevel Highest | Out-Null;` +
      `Start-ScheduledTask -TaskName 'ArgusAgent';` +
      `Start-Sleep -Seconds 2; 'ok'`
    const r = await execOnce(deviceId, psCmd(ps))
    return r.ok ? { ok: true } : { ok: false, error: r.error || r.output }
  }

  if (family === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.argus.agent</string>
<key>ProgramArguments</key><array><string>${p.bin.replace('$HOME', '~')}</string><string>--addr</string><string>0.0.0.0:${AGENT_PORT}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>`
    const cmd =
      `mkdir -p "$HOME/Library/LaunchAgents" && cat > "$HOME/Library/LaunchAgents/com.argus.agent.plist" <<'PLIST'\n${plist}\nPLIST\n` +
      `launchctl unload "$HOME/Library/LaunchAgents/com.argus.agent.plist" 2>/dev/null; ` +
      `launchctl load "$HOME/Library/LaunchAgents/com.argus.agent.plist" && echo ok`
    const r = await execOnce(deviceId, cmd)
    return r.ok ? { ok: true } : { ok: false, error: r.error || r.output }
  }

  // Linux: пользовательский юнит systemd. Плюс права на /dev/uinput — без них не будет
  // управления (просмотр останется). Правило ставим best-effort: sudo может не быть.
  const unit = `[Unit]
Description=Argus screen agent
After=graphical-session.target

[Service]
ExecStart=%h/.argus/argus-agent --addr 0.0.0.0:${AGENT_PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`
  const cmd =
    `mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/.config/systemd/user/argus-agent.service" <<'UNIT'\n${unit}UNIT\n` +
    `systemctl --user daemon-reload && systemctl --user enable --now argus-agent.service && ` +
    // uinput: группа input + правило udev. Без sudo просто пропускаем — агент скажет об этом сам.
    `{ sudo -n sh -c 'modprobe uinput; usermod -aG input '"$USER"'; printf %s "KERNEL==\\"uinput\\", GROUP=\\"input\\", MODE=\\"0660\\"\\n" > /etc/udev/rules.d/99-argus-uinput.rules; udevadm control --reload-rules; udevadm trigger' >/dev/null 2>&1 || true; }; ` +
    `echo ok`
  const r = await execOnce(deviceId, cmd)
  return r.ok ? { ok: true } : { ok: false, error: r.error || r.output }
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
    const remote =
      family === 'windows' ? `${base}\\Argus\\${remoteName}` : `${base}/.argus/${remoteName}`
    const r = await sftpPutFile(s.sessionId, localPath, remote)
    if (!r.ok) return { ok: false, error: r.error }
    if (family !== 'windows') await execOnce(deviceId, `chmod 755 "$HOME/.argus/${remoteName}"`)
    return { ok: true }
  } finally {
    sftpClose(s.sessionId)
  }
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
  return { ok: true, url: `wss://${conn.host}:${AGENT_PORT}/stream`, token }
}

export { AGENT_VERSION }
