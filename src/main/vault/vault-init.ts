import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export interface VaultMeta {
  salt: string
  version: number
  createdAt: number
}

function parseMeta(path: string): VaultMeta {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<VaultMeta>
  if (
    !/^[0-9a-f]{32}$/i.test(value.salt ?? '') ||
    value.version !== 1 ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt <= 0
  ) {
    throw new Error('invalid vault metadata')
  }
  return value as VaultMeta
}

/**
 * Подготовить восстанавливаемую соль ДО создания зашифрованной БД.
 *
 * `meta.new` намеренно остаётся на месте при сбое: повторный initialize обязан взять ту же
 * соль. Любая неполная пара из уже опубликованных meta/DB блокирует автоматическую запись —
 * иначе попытка «починить» хранилище уничтожит последний материал для восстановления.
 */
export function prepareVaultInitialization(databasePath: string, publishedMetaPath: string): VaultMeta {
  const pendingPath = `${publishedMetaPath}.new`

  if (existsSync(publishedMetaPath)) {
    throw new Error('Найдены метаданные шифрования без базы; существующий файл не перезаписан')
  }

  if (existsSync(pendingPath)) {
    try {
      return parseMeta(pendingPath)
    } catch {
      throw new Error(
        'Незавершённое создание хранилища: файл метаданных повреждён; существующую базу не перезаписываю'
      )
    }
  }

  if (existsSync(databasePath)) {
    throw new Error('Найдена база без метаданных шифрования; существующий файл не перезаписан')
  }

  const meta: VaultMeta = {
    salt: randomBytes(16).toString('hex'),
    version: 1,
    createdAt: Date.now()
  }
  writeFileSync(pendingPath, JSON.stringify(meta), { mode: 0o600 })
  return meta
}
