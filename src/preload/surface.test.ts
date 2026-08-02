// Замок на поверхность IPC.
//
// Мост между main и renderer — это ровно та граница, ради которой в приложении есть изоляция
// контекста. Сейчас её удерживает только комментарий в `preload/screen.ts` («здесь намеренно
// НЕТ vault/devices/ssh»), а комментарий ничего не удерживает: любой новый канал протекает
// молча, и заметить это можно лишь вычитав два файла подряд.
//
// Тест читает исходники и сверяет три вещи: направление вызова совпадает с направлением
// обработчика, у каждого вызова есть обработчик и наоборот, и окно трансляции не видит ничего
// из того, что ему видеть нельзя.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

const IPC = read('main/ipc.ts')
const PRELOAD = read('preload/index.ts')
const SCREEN_PRELOAD = read('preload/screen.ts')

const all = (src: string, re: RegExp): string[] => [...src.matchAll(re)].map((m) => m[1]).sort()

/** Каналы main: `handle` отвечает на invoke, `on` принимает send. */
const handled = all(IPC, /ipcMain\.handle\('([^']+)'/g)
const received = all(IPC, /ipcMain\.on\('([^']+)'/g)

/** Каналы renderer: invoke ждёт ответа, send — нет, on слушает события от main. */
const invoked = (src: string): string[] => all(src, /ipcRenderer\.invoke\('([^']+)'/g)
const sent = (src: string): string[] => all(src, /ipcRenderer\.send\('([^']+)'/g)
const listened = (src: string): string[] => all(src, /ipcRenderer\.on\('([^']+)'/g)

/** События main → renderer: их не «обрабатывают», их шлют через webContents. */
const EVENTS = ['ssh:data', 'ssh:exit', 'devices:geo']

const unique = (xs: string[]): string[] => [...new Set(xs)].sort()

describe('поверхность IPC — направление вызова', () => {
  it('всё, что renderer вызывает через invoke, обработано через handle', () => {
    for (const ch of unique([...invoked(PRELOAD), ...invoked(SCREEN_PRELOAD)])) {
      expect(handled, `канал ${ch} вызывается, но не обработан`).toContain(ch)
    }
  })

  it('всё, что renderer шлёт через send, принято через on', () => {
    for (const ch of unique([...sent(PRELOAD), ...sent(SCREEN_PRELOAD)])) {
      expect(received, `канал ${ch} отправляется, но не принимается`).toContain(ch)
    }
  })

  it('направления не перепутаны: invoke не отвечает на on, и наоборот', () => {
    const calls = unique([...invoked(PRELOAD), ...invoked(SCREEN_PRELOAD)])
    const sends = unique([...sent(PRELOAD), ...sent(SCREEN_PRELOAD)])
    // Канал, обработанный через handle, но вызванный через send, тихо теряет ответ.
    for (const ch of sends) expect(handled, `${ch} шлётся через send, но обработан как handle`).not.toContain(ch)
    for (const ch of calls) expect(received, `${ch} вызывается invoke, но принят как on`).not.toContain(ch)
  })

  it('renderer слушает только те события, которые main действительно шлёт', () => {
    for (const ch of unique(listened(PRELOAD))) {
      expect(EVENTS, `renderer слушает ${ch}, но main такого не шлёт`).toContain(ch)
    }
  })
})

describe('поверхность IPC — ничего лишнего', () => {
  it('у каждого обработчика main есть вызывающий в мосте', () => {
    const reachable = unique([
      ...invoked(PRELOAD),
      ...sent(PRELOAD),
      ...invoked(SCREEN_PRELOAD),
      ...sent(SCREEN_PRELOAD)
    ])
    const orphans = unique([...handled, ...received]).filter((ch) => !reachable.includes(ch))
    // Обработчик без вызывающего — это либо мёртвый код, либо поверхность, о которой забыли.
    expect(orphans, `обработчики без вызывающего: ${orphans.join(', ')}`).toEqual([])
  })

  it('в мосте нет каналов-дублей', () => {
    const calls = [...invoked(PRELOAD), ...sent(PRELOAD)]
    // Один канал — одна точка входа: два разных метода на один канал развели бы поведение.
    expect(calls.length).toBe(new Set(calls).size)
  })
})

describe('окно трансляции видит только своё', () => {
  const FORBIDDEN = ['vault:', 'devices:', 'ssh:', 'sftp:', 'forward:', 'agent:', 'ai:', 'wallets:', 'subs:', 'pc:', 'ports:', 'hw:', 'metrics:', 'net:', 'snippets:', 'alerts:', 'discovery:', 'sshconfig:', 'assist:']

  it('не имеет доступа ни к хранилищу, ни к парку, ни к SSH', () => {
    const channels = unique([
      ...invoked(SCREEN_PRELOAD),
      ...sent(SCREEN_PRELOAD),
      ...listened(SCREEN_PRELOAD)
    ])
    for (const ch of channels) {
      const bad = FORBIDDEN.find((p) => ch.startsWith(p))
      expect(bad, `окно трансляции получило доступ к ${ch}`).toBeUndefined()
    }
  })

  it('его поверхность заведомо мала — это часть замысла, а не совпадение', () => {
    const channels = unique([...invoked(SCREEN_PRELOAD), ...sent(SCREEN_PRELOAD)])
    // Компрометация canvas-окна не должна превращаться в доступ ко всему командному центру.
    // Порог намеренно жёсткий: рост поверхности обязан быть замечен.
    expect(channels.length).toBeLessThanOrEqual(8)
    expect(channels).toContain('screen:claim')
  })

  it('не выставляет наружу ничего, кроме одного объекта api', () => {
    const exposed = all(SCREEN_PRELOAD, /contextBridge\.exposeInMainWorld\('([^']+)'/g)
    expect(exposed).toEqual(['api'])
  })
})

describe('мост главного окна', () => {
  it('тоже выставляет ровно один объект', () => {
    const exposed = all(PRELOAD, /contextBridge\.exposeInMainWorld\('([^']+)'/g)
    expect(exposed).toEqual(['api'])
  })

  it('не пробрасывает в renderer сам ipcRenderer', () => {
    // Классическая дыра: отдать мост целиком — и изоляция контекста перестаёт что-либо значить.
    expect(PRELOAD).not.toMatch(/exposeInMainWorld\([^)]*,\s*ipcRenderer\s*\)/)
    expect(SCREEN_PRELOAD).not.toMatch(/exposeInMainWorld\([^)]*,\s*ipcRenderer\s*\)/)
  })
})
