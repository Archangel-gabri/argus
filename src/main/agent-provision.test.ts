import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: vi.fn(() => '/opt/argus') } }))
vi.mock('./ssh', () => ({ execOnce: vi.fn(), resolveConn: vi.fn() }))
vi.mock('./pc', () => ({ whichOs: vi.fn() }))
vi.mock('./vault', () => ({
  getAgentToken: vi.fn(),
  setAgentToken: vi.fn(),
  getAgentCert: vi.fn(),
  setAgentCert: vi.fn()
}))

import {
  buildDarwinInstallCommand,
  buildDarwinLaunchAgent,
  buildDarwinSelftestCommand,
  buildLinuxInstallCommand,
  darwinTargetPaths
} from './agent'

const syntaxOk = (cmd: string): boolean => {
  try {
    execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

describe('macOS provisioning contract', () => {
  it('использует один абсолютный каталог для бинаря, credential и сертификата', () => {
    expect(darwinTargetPaths('/Users/danya')).toEqual({
      dir: '/Users/danya/.argus',
      bin: '/Users/danya/.argus/argus-agent',
      token: '/Users/danya/.argus/agent.token',
      cert: '/Users/danya/.argus/agent.crt'
    })
  })

  it('создаёт Aqua LaunchAgent с абсолютными и XML-безопасными путями', () => {
    const paths = darwinTargetPaths('/Users/A&B User')
    const plist = buildDarwinLaunchAgent(paths)
    expect(plist).toContain('/Users/A&amp;B User/.argus/argus-agent')
    expect(plist).toContain('--token-file')
    expect(plist).toContain('/Users/A&amp;B User/.argus/agent.token')
    expect(plist).toContain('--cert-dir')
    expect(plist).toContain('<key>LimitLoadToSessionType</key><string>Aqua</string>')
    expect(plist).toContain('/opt/homebrew/bin:/usr/local/bin:')
    expect(plist).not.toContain('<string>~')
    expect(plist).not.toContain('<string>$HOME')
  })

  it('атомарно публикует plist и проверяет job в gui-домене', () => {
    const paths = darwinTargetPaths('/Users/danya')
    const cmd = buildDarwinInstallCommand(paths, '501')
    expect(cmd).toContain('launchctl bootout')
    expect(cmd).toContain('launchctl bootstrap')
    expect(cmd).toContain('launchctl kickstart -k')
    expect(cmd).toContain('launchctl print')
    expect(cmd).toContain('.plist.new')
    expect(cmd).not.toContain('launchctl load')
    expect(cmd).not.toContain('launchctl unload')
    expect(syntaxOk(cmd)).toBe(true)
  })

  it('запускает selftest в bootstrap-контексте GUI-пользователя', () => {
    const cmd = buildDarwinSelftestCommand(darwinTargetPaths('/Users/danya'), '501')
    expect(cmd).toContain('launchctl asuser')
    expect(cmd).toContain('HOME=/Users/danya')
    expect(cmd).toContain('--selftest')
  })
})

describe('Linux linger contract', () => {
  it('пытается включить linger и прерывает установку, пока факт не стал yes', () => {
    const cmd = buildLinuxInstallCommand()
    expect(cmd).toContain('loginctl show-user "$USER" -P Linger')
    expect(cmd).toContain('sudo -n loginctl enable-linger "$USER"')
    expect(cmd).toContain('LINGER_NOT_ENABLED')
    expect(cmd).toMatch(/\[ "\$LINGER" = yes \]/)
    expect(syntaxOk(cmd)).toBe(true)
  })
})
