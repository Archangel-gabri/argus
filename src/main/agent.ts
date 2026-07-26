// Провижининг и жизненный цикл собственного агента трансляции (см. agent/ в этом репозитории).
//
// Смысл агента: RDP требует пароль учётной записи ОС и существует только на Windows. Агент
// ставится по SSH — а SSH-доступ уже доказывает контроль над машиной, — получает от Argus
// одноразово сгенерированный токен, и пароль ОС из цепочки исчезает. Один протокол на все ОС.
//
// Здесь только установка/проверка. Сам поток идёт напрямую из окна экрана к агенту.
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { execOnce, resolveConn } from './ssh'
import { whichOs } from './pc'
import { getAgentToken, setAgentToken } from './vault'

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

/** HTTP-запрос к агенту напрямую (через Tailscale). Короткий таймаут: это проверка, а не работа. */
function agentHTTP(host: string, token: string, timeoutMs = 4000): Promise<AgentStatus> {
  return new Promise((resolve) => {
    // Токен — заголовком, не в URL: строка запроса попадает в логи по всему пути.
    const req = http.get(
      {
        host,
        port: AGENT_PORT,
        path: '/health',
        timeout: timeoutMs,
        headers: { 'X-Argus-Token': token }
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
  const conn = await resolveConn(deviceId)
  if (!conn) return { installed: false, running: false, error: 'устройство не в сети' }
  return agentHTTP(conn.host, token)
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

  // Архитектуру спрашиваем у самой машины — гадать нельзя.
  const archProbe =
    os.family === 'windows'
      ? await execOnce(deviceId, psCmd('$env:PROCESSOR_ARCHITECTURE'))
      : await execOnce(deviceId, 'uname -m')
  const rawArch = (archProbe.output || '').trim().toLowerCase()
  const arch = /arm64|aarch64/.test(rawArch) ? 'arm64' : 'amd64'

  const bin = binaryFor(os.family, arch)
  if (!bin)
    return { ok: false, step: 'бинарь', error: `нет собранного агента под ${os.family}/${arch}` }

  const p = targetPaths(os.family)
  const token = getAgentToken(deviceId) || crypto.randomBytes(32).toString('hex')

  // 1. Каталог
  const mk =
    os.family === 'windows'
      ? await execOnce(deviceId, psCmd(`New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\\Argus" | Out-Null; 'ok'`))
      : await execOnce(deviceId, `mkdir -p "$HOME/.argus" && chmod 700 "$HOME/.argus" && echo ok`)
  if (!mk.ok) return { ok: false, step: 'каталог', error: mk.error || mk.output }

  // 2. Бинарь (SFTP)
  const up = await uploadFile(deviceId, bin, os.family === 'windows' ? 'argus-agent.exe' : 'argus-agent', os.family)
  if (!up.ok) return { ok: false, step: 'загрузка агента', error: up.error }

  // 3. Токен — файлом с правами только для владельца, не через командную строку
  //    (аргументы процесса видны всей системе в списке процессов).
  const tokWrite =
    os.family === 'windows'
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

  // 4. Автозапуск
  const svc = await installService(deviceId, os.family, p)
  if (!svc.ok) return { ok: false, step: 'автозапуск', error: svc.error }

  // 5. Самотест — единственный честный критерий «работает»
  const st =
    os.family === 'windows'
      ? await execOnce(deviceId, psCmd(`& "$env:LOCALAPPDATA\\Argus\\argus-agent.exe" --selftest 2>&1 | Out-String`))
      : await execOnce(deviceId, `"$HOME/.argus/argus-agent" --selftest 2>&1`)

  setAgentToken(deviceId, token)
  const status = await agentHTTP(conn.host, token, 6000)
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
  const conn = await resolveConn(deviceId)
  if (!conn) return { ok: false, error: 'устройство не в сети' }
  return { ok: true, url: `ws://${conn.host}:${AGENT_PORT}/stream`, token }
}

export { AGENT_VERSION }
