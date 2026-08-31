#!/usr/bin/env node
// Smoke проверяет именно готовый AppImage, а не исходники или dist/linux-unpacked.
// electron-builder не считает отсутствующий extraResources ошибкой: он печатает warning
// и собирает образ без ресурса. Поэтому контракт проверяется после упаковки.
//
//   npm run test:artifact
//   node tools/appimage-smoke.mjs /path/to/Argus.AppImage

import { X509Certificate } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const requestedImage = process.argv[2]
const image = requestedImage && requestedImage !== '--self-test'
  ? resolve(requestedImage)
  : join(root, 'dist', `Argus-${pkg.version}.AppImage`)

const AGENTS = [
  ['argus-agent-linux-amd64', 'linux-amd64'],
  ['argus-agent-linux-arm64', 'linux-arm64'],
  ['argus-agent-windows-amd64.exe', 'windows-amd64'],
  ['argus-agent-darwin-amd64', 'darwin-amd64'],
  ['argus-agent-darwin-arm64', 'darwin-arm64'],
]

const check = (condition, message) => {
  if (!condition) throw new Error(message)
}

const requireFile = (path, label, minBytes = 1) => {
  check(existsSync(path), `${label}: файл не попал в AppImage (${path})`)
  const size = statSync(path).size
  check(size >= minBytes, `${label}: файл подозрительно мал (${size} байт)`)
  return path
}

const binaryKind = (path) => {
  // Для формата достаточно заголовка; не читаем целиком 160+ МБ AppImage в память.
  const fd = openSync(path, 'r')
  const header = Buffer.alloc(64 * 1024)
  let bytesRead
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0)
  } finally {
    closeSync(fd)
  }
  const b = header.subarray(0, bytesRead)
  if (
    b.length >= 20 &&
    b.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    check(
      b[4] === 2 && b[5] === 1,
      `${path}: ожидался 64-bit little-endian ELF`,
    )
    return b.readUInt16LE(18) === 183
      ? 'linux-arm64'
      : b.readUInt16LE(18) === 62
        ? 'linux-amd64'
        : 'elf-unknown'
  }
  if (b.length >= 0x40 && b[0] === 0x4d && b[1] === 0x5a) {
    const pe = b.readUInt32LE(0x3c)
    if (
      pe + 6 <= b.length &&
      b.subarray(pe, pe + 4).equals(Buffer.from('PE\0\0'))
    ) {
      return b.readUInt16LE(pe + 4) === 0x8664 ? 'windows-amd64' : 'pe-unknown'
    }
  }
  if (
    b.length >= 8 &&
    b.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  ) {
    const cpu = b.readUInt32LE(4)
    return cpu === 0x01000007
      ? 'darwin-amd64'
      : cpu === 0x0100000c
        ? 'darwin-arm64'
        : 'macho-unknown'
  }
  return 'unknown'
}

const assertExactAgentSet = (agentDir) => {
  const entries = readdirSync(agentDir, { withFileTypes: true })
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name).sort()
  check(
    nonFiles.length === 0,
    `каталог агентов содержит не обычные файлы: ${nonFiles.join(', ')}`,
  )

  const actual = entries.map((entry) => entry.name).sort()
  const expected = AGENTS.map(([name]) => name).sort()
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `неверный набор агентов: ожидались ${expected.join(', ')}; получены ${actual.join(', ')}`,
  )
}

const selfTest = () => {
  const scratch = mkdtempSync(join(tmpdir(), 'argus-appimage-contract-'))
  try {
    for (const [name] of AGENTS) writeFileSync(join(scratch, name), 'fixture')
    assertExactAgentSet(scratch)

    writeFileSync(join(scratch, 'unexpected-debug-file'), 'fixture')
    let rejected = false
    try {
      assertExactAgentSet(scratch)
    } catch {
      rejected = true
    }
    check(rejected, 'exact-set контракт пропустил лишний файл')
    console.log('AppImage contract self-test PASS: лишний agent-файл отклоняется')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const verifyArtifact = () => {
  requireFile(image, 'AppImage', 1_000_000)
  check(
    binaryKind(image) === 'linux-amd64',
    'AppImage: релизный контракт требует Linux x86_64',
  )
  const scratch = mkdtempSync(join(tmpdir(), 'argus-appimage-smoke-'))

  try {
    const extracted = spawnSync(image, ['--appimage-extract'], {
      cwd: scratch,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    check(
      !extracted.error,
      `AppImage не запустил распаковку: ${extracted.error?.message}`,
    )
    check(
      extracted.status === 0,
      `AppImage не распаковался (rc=${extracted.status}): ${extracted.stderr.trim()}`,
    )

    const resources = join(scratch, 'squashfs-root', 'resources')

    const pricesPath = requireFile(
      join(resources, 'ai', 'model-prices.json'),
      'каталог цен ИИ',
      10_000,
    )
    const prices = JSON.parse(readFileSync(pricesPath, 'utf8'))
    check(prices.source === 'litellm', 'каталог цен ИИ: неожиданный source')
    check(
      Array.isArray(prices.models) && prices.models.length > 100,
      'каталог цен ИИ: меньше 101 модели',
    )

    const caPath = requireFile(
      join(resources, 'ca', 'russian-trusted-ca.pem'),
      'корень УЦ',
      1_000,
    )
    const ca = new X509Certificate(readFileSync(caPath))
    check(ca.ca, 'корень УЦ: сертификат не помечен как CA')

    const nativePath = requireFile(
      join(
        resources,
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3-multiple-ciphers',
        'build',
        'Release',
        'better_sqlite3.node',
      ),
      'SQLCipher native module',
      100_000,
    )
    check(
      binaryKind(nativePath) === 'linux-amd64',
      'SQLCipher native module: неверный формат/архитектура',
    )

    const agentDir = join(resources, 'agent')
    assertExactAgentSet(agentDir)
    for (const [name, kind] of AGENTS) {
      const path = requireFile(join(agentDir, name), `агент ${name}`, 1_000_000)
      check(
        binaryKind(path) === kind,
        `агент ${name}: ожидался ${kind}, получен ${binaryKind(path)}`,
      )
    }

    const hostAgent = join(agentDir, 'argus-agent-linux-amd64')
    const version = spawnSync(hostAgent, ['--version'], { encoding: 'utf8' })
    check(
      version.status === 0,
      `Linux-агент не запустился (rc=${version.status})`,
    )
    check(
      version.stdout.trim() === `argus-agent ${pkg.version} (linux/amd64)`,
      `Linux-агент вернул неожиданную версию: ${version.stdout.trim()}`,
    )

    console.log(
      `AppImage smoke PASS: ${AGENTS.length} агентов, ${prices.models.length} цен, CA и SQLCipher на месте`,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (requestedImage === '--self-test') selfTest()
else verifyArtifact()
