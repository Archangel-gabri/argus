// Срок на операцию, которую можно отменить. Проверяется не «сработал ли таймер», а три вещи,
// ради которых это вообще написано: поздний вызов ничего не применяет, отмена идёт после
// захвата права, и то, что появилось поздно, утилизируется.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DeadlineError, withDeadline } from './deadline'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('withDeadline', () => {
  it('успех до срока проходит, отмена не зовётся', async () => {
    const dispose = vi.fn()
    const p = withDeadline<string>({ ms: 1000, dispose, run: (gate) => void gate.settle(() => 'готово') })
    await expect(p).resolves.toBe('готово')
    expect(dispose).not.toHaveBeenCalled()
  })

  it('молчащий источник даёт отказ по сроку и отмену', async () => {
    const dispose = vi.fn()
    const p = withDeadline<string>({ ms: 5000, dispose, run: () => {} })
    const check = expect(p).rejects.toBeInstanceOf(DeadlineError)
    await vi.advanceTimersByTimeAsync(5000)
    await check
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('поздний вызов НЕ выполняет то, что должно случиться при успехе', async () => {
    // Ради этого всё и написано: гонка освободила бы ждущего, но поздний вызов всё равно завёл
    // бы сессию, которой уже никто не владеет.
    const commit = vi.fn(() => 'поздно')
    const discard = vi.fn()
    let late: (() => void) | null = null
    const p = withDeadline<string>({
      ms: 1000,
      dispose: () => {},
      run: (gate) => {
        late = () => gate.settle(commit, discard)
      }
    })
    const check = expect(p).rejects.toBeInstanceOf(DeadlineError)
    await vi.advanceTimersByTimeAsync(1000)
    await check

    late!()
    expect(commit).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledTimes(1) // то, что пришло поздно, утилизировано
  })

  it('отмена, породившая событие, не подменяет причину отказа', async () => {
    // Отмена идёт ПОСЛЕ захвата права. Если бы порядок был обратным, синхронный `close` внутри
    // отмены успел бы отклонить операцию своей ошибкой, и вместо «не уложились в срок» человек
    // читал бы «соединение закрыто» — то есть следствие вместо причины.
    let gateRef: { reject: (e: unknown) => boolean } | null = null
    const p = withDeadline<string>({
      ms: 1000,
      dispose: () => gateRef?.reject(new Error('соединение закрыто')),
      run: (gate) => {
        gateRef = gate
      }
    })
    const check = expect(p).rejects.toThrow(/не уложилась/)
    await vi.advanceTimersByTimeAsync(1000)
    await check
  })

  it('active() гаснет после срока — промежуточная фаза не запустится', async () => {
    let gateRef: { active: () => boolean } | null = null
    const p = withDeadline<string>({ ms: 1000, dispose: () => {}, run: (gate) => { gateRef = gate } })
    expect(gateRef!.active()).toBe(true)
    const check = expect(p).rejects.toBeInstanceOf(DeadlineError)
    await vi.advanceTimersByTimeAsync(1000)
    await check
    expect(gateRef!.active()).toBe(false)
  })

  it('отказ работы завершает операцию, а не уходит в никуда', async () => {
    const p = withDeadline<string>({
      ms: 1000,
      dispose: () => {},
      run: async () => {
        throw new Error('сорвалось сразу')
      }
    })
    await expect(p).rejects.toThrow('сорвалось сразу')
  })

  it('синхронный успех внутри run не оставляет висящий таймер', async () => {
    const dispose = vi.fn()
    await expect(
      withDeadline<number>({ ms: 1000, dispose, run: (gate) => void gate.settle(() => 42) })
    ).resolves.toBe(42)
    await vi.advanceTimersByTimeAsync(5000)
    expect(dispose).not.toHaveBeenCalled()
  })
})
