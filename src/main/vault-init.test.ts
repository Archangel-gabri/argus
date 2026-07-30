import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareVaultInitialization, type VaultMeta } from './vault-init'

const dirs: string[] = []

function paths(): { dir: string; db: string; meta: string; pending: string } {
  const dir = mkdtempSync(join(tmpdir(), 'argus-vault-init-'))
  dirs.push(dir)
  const meta = join(dir, 'vault.meta.json')
  return { dir, db: join(dir, 'vault.db'), meta, pending: `${meta}.new` }
}

function validMeta(): VaultMeta {
  return { salt: '0123456789abcdef0123456789abcdef', version: 1, createdAt: 1_700_000_000_000 }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('аварийное создание vault', () => {
  it('пишет восстанавливаемую соль до базы и не публикует её преждевременно', () => {
    const p = paths()

    const meta = prepareVaultInitialization(p.db, p.meta)

    expect(meta.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(readFileSync(p.pending, 'utf8'))).toEqual(meta)
    expect(() => readFileSync(p.meta)).toThrow()
    // Соль — часть ключевого материала. Umask может только дополнительно убрать права.
    expect(statSync(p.pending).mode & 0o077).toBe(0)
  })

  it('после crash повторяет создание с той же солью, даже если база уже появилась', () => {
    const p = paths()
    const meta = validMeta()
    writeFileSync(p.pending, JSON.stringify(meta))
    writeFileSync(p.db, 'encrypted database placeholder')

    expect(prepareVaultInitialization(p.db, p.meta)).toEqual(meta)
    expect(JSON.parse(readFileSync(p.pending, 'utf8'))).toEqual(meta)
  })

  it('не затирает базу, у которой потерялись опубликованные метаданные', () => {
    const p = paths()
    writeFileSync(p.db, 'recover me')

    expect(() => prepareVaultInitialization(p.db, p.meta)).toThrow(/база без метаданных/i)
    expect(readFileSync(p.db, 'utf8')).toBe('recover me')
  })

  it('не затирает опубликованную соль, если пропала сама база', () => {
    const p = paths()
    const raw = JSON.stringify(validMeta())
    writeFileSync(p.meta, raw)

    expect(() => prepareVaultInitialization(p.db, p.meta)).toThrow(/метаданные шифрования без базы/i)
    expect(readFileSync(p.meta, 'utf8')).toBe(raw)
  })

  it('останавливается на повреждённом pending meta вместо генерации нового ключа', () => {
    const p = paths()
    writeFileSync(p.pending, '{"salt":"короткая"}')

    expect(() => prepareVaultInitialization(p.db, p.meta)).toThrow(/файл метаданных повреждён/i)
    expect(readFileSync(p.pending, 'utf8')).toBe('{"salt":"короткая"}')
  })
})
