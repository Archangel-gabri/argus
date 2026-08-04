import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_HOURS,
  buildBlocks,
  currentBlock,
  formatResetIn,
  mergeBlocks,
  windowState,
  type UsageBlock
} from './ai-blocks'

const HOUR = 3600_000
const at = (h: number, m = 0): number => Date.parse('2026-08-04T00:00:00Z') + h * HOUR + m * 60_000
const rec = (h: number, tokens = 1000, costUsd = 1): { ts: number; tokens: number; costUsd: number } => ({
  ts: at(h),
  tokens,
  costUsd
})

describe('окна лимита', () => {
  it('окно начинается с первого обращения, а не по часам', () => {
    const [b] = buildBlocks([rec(14.5)])
    expect(b.startTs).toBe(at(14.5))
    expect(b.endTs).toBe(at(19.5))
  })

  it('ответы внутри окна наполняют его, но не двигают конец', () => {
    // Если бы конец сдвигался за последним ответом, окно не закрывалось бы никогда, и
    // «сбросится через…» врало бы при каждой активности.
    const [b] = buildBlocks([rec(10), rec(12), rec(14.9)])
    expect(b.endTs).toBe(at(15))
    expect(b.requests).toBe(3)
    expect(b.tokens).toBe(3000)
  })

  it('первый ответ после конца открывает новое окно', () => {
    const blocks = buildBlocks([rec(10), rec(15.1)])
    expect(blocks).toHaveLength(2)
    expect(blocks[1].startTs).toBe(at(15.1))
  })

  it('порядок записей не важен — файлы читаются как попало', () => {
    const a = buildBlocks([rec(10), rec(12), rec(16)])
    const b = buildBlocks([rec(16), rec(10), rec(12)])
    expect(b).toEqual(a)
  })

  it('записи без времени отбрасываются, а не создают окно в 1970 году', () => {
    expect(buildBlocks([{ ts: 0, tokens: 5, costUsd: 1 }])).toHaveLength(0)
  })

  it('длительность окна настраивается — не у всех провайдеров пять часов', () => {
    const [b] = buildBlocks([rec(10)], 3)
    expect(b.endTs).toBe(at(13))
  })

  it('запись продолжает уже сохранённое окно, а не открывает своё поверх', () => {
    // Хранилище прибавляет к блоку по совпадению начала — поэтому продолжение окна обязано
    // выйти с НАЧАЛОМ сохранённого окна и только новыми токенами. Без этого каждый проход
    // открывал бы окно заново, и в базе копились бы перекрывающиеся осколки.
    const saved: UsageBlock[] = [
      { startTs: at(10), endTs: at(15), tokens: 5_000_000, costUsd: 5, requests: 10 }
    ]
    const fresh = buildBlocks([rec(12.5, 2_000_000)], DEFAULT_WINDOW_HOURS, saved)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].startTs).toBe(at(10))
    expect(fresh[0].endTs).toBe(at(15))
    // Только дельта: сохранённые 5M уже лежат в базе, их сюда включать — задвоить.
    expect(fresh[0].tokens).toBe(2_000_000)
    expect(fresh[0].requests).toBe(1)
  })

  it('запись после конца сохранённого окна открывает новое', () => {
    const saved: UsageBlock[] = [{ startTs: at(10), endTs: at(15), tokens: 1000, costUsd: 1, requests: 1 }]
    const fresh = buildBlocks([rec(15.5)], DEFAULT_WINDOW_HOURS, saved)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].startTs).toBe(at(15.5))
    expect(fresh[0].endTs).toBe(at(20.5))
  })
})

describe('слияние проходов', () => {
  const block = (h: number, tokens: number): UsageBlock => ({
    startTs: at(h),
    endTs: at(h + 5),
    tokens,
    costUsd: 1,
    requests: 1
  })

  it('одно и то же окно суммируется, а не задваивается записями', () => {
    const merged = mergeBlocks([block(10, 100)], [block(10, 50)])
    expect(merged).toHaveLength(1)
    expect(merged[0].tokens).toBe(150)
    expect(merged[0].requests).toBe(2)
  })

  it('новое окно добавляется и список остаётся упорядоченным', () => {
    const merged = mergeBlocks([block(16, 10)], [block(10, 20)])
    expect(merged.map((b) => b.startTs)).toEqual([at(10), at(16)])
  })

  it('перекрывающиеся окна сливаются: осколок — то же окно, увиденное с середины', () => {
    // Разговор А с 10:00 (5M) и Б с 12:30 (2M) записаны разными проходами как два окна.
    // Окно ОДНО — с 10:00: в 13:00 карточка обязана видеть 7M, а не 2M последнего осколка.
    const merged = mergeBlocks([block(10, 5_000_000)], [block(12.5, 2_000_000)])
    expect(merged).toHaveLength(1)
    expect(merged[0].startTs).toBe(at(10))
    // Конец не уезжает за осколком: его «конец» отмерен от середины настоящего окна и лжёт.
    expect(merged[0].endTs).toBe(at(15))
    expect(merged[0].tokens).toBe(7_000_000)
    expect(merged[0].requests).toBe(2)
  })

  it('конец осколка не склеивает цепочку настоящих окон', () => {
    // Если бы конец слитого окна расширялся до 17:30, настоящее окно 16:00 влилось бы в
    // цепочку — и при непрерывной работе окно не закрывалось бы никогда.
    const merged = mergeBlocks([block(10, 100), block(12.5, 50)], [block(16, 10)])
    expect(merged.map((b) => b.startTs)).toEqual([at(10), at(16)])
    expect(merged[0].endTs).toBe(at(15))
  })
})

describe('текущее окно', () => {
  const blocks = buildBlocks([rec(10, 40_000), rec(11, 20_000)])

  it('находится, пока не истекло', () => {
    expect(currentBlock(blocks, at(12))?.startTs).toBe(at(10))
    expect(currentBlock(blocks, at(16))).toBeNull()
  })

  it('доля считается только от заданного потолка', () => {
    const s = windowState(blocks, 200_000, at(13, 21))
    expect(s?.used).toBeCloseTo(0.3, 5)
    expect(formatResetIn(s?.resetsInMs ?? 0)).toBe('через 1 ч 39 мин')
  })

  it('без потолка доля не выдумывается', () => {
    // Anthropic порогов не публикует: «57 % израсходовано» без знаменателя — это выдумка.
    const s = windowState(blocks, null, at(12))
    expect(s?.used).toBeNull()
    expect(s?.elapsed).toBeCloseTo(0.4, 5)
  })

  it('перебор потолка виден, а не срезается до сотни процентов', () => {
    const s = windowState(blocks, 30_000, at(12))
    expect(s?.used).toBeCloseTo(2, 5)
  })

  it('окна нет — состояния нет', () => {
    expect(windowState(blocks, 100, at(20))).toBeNull()
  })

  it('окно из осколков хранилища читается целиком, а не последним куском', () => {
    // В хранилище могли остаться перекрывающиеся блоки прежних проходов. Без слияния бралось
    // последнее по началу: карточка показывала 2M вместо 7M и «сброс через 4½ ч» вместо 2 ч.
    const fragments: UsageBlock[] = [
      { startTs: at(10), endTs: at(15), tokens: 5_000_000, costUsd: 5, requests: 10 },
      { startTs: at(12.5), endTs: at(17.5), tokens: 2_000_000, costUsd: 2, requests: 4 }
    ]
    const s = windowState(fragments, null, at(13))
    expect(s?.block.startTs).toBe(at(10))
    expect(s?.block.tokens).toBe(7_000_000)
    expect(s?.resetsInMs).toBe(2 * HOUR)
  })
})

describe('время до сброса словами', () => {
  it('читается как у человека', () => {
    expect(formatResetIn(99 * 60_000)).toBe('через 1 ч 39 мин')
    expect(formatResetIn(120 * 60_000)).toBe('через 2 ч')
    expect(formatResetIn(45 * 60_000)).toBe('через 45 мин')
    expect(formatResetIn(20_000)).toBe('вот-вот')
    expect(formatResetIn(-5)).toBe('вот-вот')
  })
})
