// Живучесть хранилища: восстановление после сбоя посреди смены мастер-пароля.
//
// Здесь уже был критический дефект — `changePassword` мог окиpпичить vault навсегда, — и
// починен он двухфазной фиксацией: новая соль пишется в `meta.json.new` ДО перешифровки, а
// публикуется атомарным переименованием после. Значит существуют промежуточные состояния на
// диске, и приложение обязано разбирать каждое.
//
// Процесс здесь не убивается по-настоящему: вместо этого состояния ВОСПРОИЗВОДЯТСЯ на диске
// поимённо. Так проверяется ровно то, что и должно, — логика согласования, — и проверка
// остаётся детерминированной. Честная граница: настоящий SIGKILL мог бы оставить ещё и
// повреждённый WAL, и этот класс сюда не входит.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'argus-recovery-'))
const DB = join(TMP, 'nexus-vault.db')
const META = join(TMP, 'nexus-vault.meta.json')
const META_NEW = `${META}.new`
const BACKUP = join(TMP, 'backup.db')
const META_BACKUP = join(TMP, 'backup.meta.json')

const FIRST = 'test-master-password-one'
const SECOND = 'test-master-password-two'

vi.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
  clipboard: {},
  session: { defaultSession: {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

describe('восстановление хранилища после сбоя', () => {
  let vault: typeof import('./vault')

  beforeAll(async () => {
    vault = await import('./vault')
    await vault.initialize(FIRST)
    vault.createDevice({ name: 'маркер', provider: 'Custom', ip: '203.0.113.1' })
    vault.lock()
    // Эталон исходного состояния: к нему возвращаемся перед каждым сценарием.
    copyFileSync(DB, BACKUP)
    copyFileSync(META, META_BACKUP)
  })

  afterEach(() => {
    vault.lock()
    copyFileSync(BACKUP, DB)
    copyFileSync(META_BACKUP, META)
    if (existsSync(META_NEW)) unlinkSync(META_NEW)
  })

  const marker = (): boolean => vault.listDevices().some((d) => d.name === 'маркер')

  it('сбой ПОСЛЕ записи новой соли, но ДО перешифровки', async () => {
    // На диске лежит .new с солью, которой ещё никто не пользовался. База по-прежнему на
    // старом пароле — значит открыть её обязан старый, а осиротевший .new должен исчезнуть.
    const stale = JSON.parse(readFileSync(META, 'utf8')) as { salt: string }
    writeFileSync(META_NEW, JSON.stringify({ ...stale, salt: 'ff'.repeat(16) }))

    await vault.unlock(FIRST)
    expect(marker()).toBe(true)
    expect(existsSync(META_NEW), 'устаревший .new остался лежать и будет мешать в следующий раз').toBe(false)
  })

  it('сбой ПОСЛЕ перешифровки, но ДО публикации новой соли', async () => {
    // Самое опасное состояние: база уже на новом пароле, а meta.json указывает на старую соль.
    // Без согласования ключ к базе был бы потерян навсегда — именно этот случай и был багом.
    const oldMeta = readFileSync(META, 'utf8')
    await vault.unlock(FIRST)
    await vault.changePassword(FIRST, SECOND)
    const newMeta = readFileSync(META, 'utf8')
    vault.lock()

    // Откатываем публикацию: meta — старая, новая соль лежит в .new, база уже перешифрована.
    writeFileSync(META, oldMeta)
    writeFileSync(META_NEW, newMeta)

    await vault.unlock(SECOND)
    expect(marker()).toBe(true)
    // Согласование обязано ДОВЕСТИ публикацию до конца, иначе всё повторится при следующем входе.
    expect(existsSync(META_NEW)).toBe(false)
    expect(readFileSync(META, 'utf8')).toBe(newMeta)
  })

  it('повреждённый .new не мешает открыть хранилище', async () => {
    writeFileSync(META_NEW, '{ это не json')
    await vault.unlock(FIRST)
    expect(marker()).toBe(true)
  })

  it('пустой .new не мешает открыть хранилище', async () => {
    writeFileSync(META_NEW, '')
    await vault.unlock(FIRST)
    expect(marker()).toBe(true)
  })

  it('после согласования открывается ТОЛЬКО один пароль, а не оба', async () => {
    const oldMeta = readFileSync(META, 'utf8')
    await vault.unlock(FIRST)
    await vault.changePassword(FIRST, SECOND)
    const newMeta = readFileSync(META, 'utf8')
    vault.lock()
    writeFileSync(META, oldMeta)
    writeFileSync(META_NEW, newMeta)

    await vault.unlock(SECOND)
    vault.lock()
    // Старый пароль после состоявшейся перешифровки обязан перестать подходить: иначе
    // «сменил пароль» — это иллюзия, и прежний остаётся действующим ключом.
    await expect(vault.unlock(FIRST)).rejects.toThrow()
  })

  it('сбой между созданием базы и записью соли не выдаёт хранилище за готовое', () => {
    // Соль пишется ПЕРВОЙ именно поэтому. Но обратное состояние — база без соли — всё равно
    // возможно при чужом вмешательстве, и оно не должно читаться как «всё на месте».
    vault.lock()
    unlinkSync(META)
    expect(vault.vaultStatus()).toBe('uninitialized')
    // И наоборот: соль без базы — тоже не готовое хранилище.
    copyFileSync(META_BACKUP, META)
    unlinkSync(DB)
    expect(vault.vaultStatus()).toBe('uninitialized')
    copyFileSync(BACKUP, DB)
  })

  it('неверный пароль не трогает ни базу, ни соль', async () => {
    const dbBefore = readFileSync(DB)
    const metaBefore = readFileSync(META, 'utf8')
    await expect(vault.unlock('совершенно-не-тот-пароль')).rejects.toThrow()
    expect(readFileSync(META, 'utf8')).toBe(metaBefore)
    expect(readFileSync(DB).equals(dbBefore)).toBe(true)
    // И хранилище по-прежнему открывается своим.
    await vault.unlock(FIRST)
    expect(marker()).toBe(true)
  })
})
