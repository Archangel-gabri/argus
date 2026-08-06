// Удержание фокуса внутри открытого окна.
//
// Регрессия на реальный дефект: подложка закрывает экран, но не убирает из обхода то, что под
// ней. С последнего поля формы Tab уходил на боковую панель — невидимую, под затемнением, — где
// живёт кнопка «Закрыть хранилище». Человек, идущий по форме с клавиатуры, мог запереть
// хранилище, не понимая, куда делся фокус.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { useOverlayA11y, resetOverlayStack } from './overlay'

function Окно(): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useOverlayA11y({ open: true, onEscape: () => {}, containerRef: box })
  return (
    <>
      <button>снаружи до</button>
      <div ref={box}>
        <button>первая</button>
        <button>последняя</button>
      </div>
      <button>снаружи после</button>
    </>
  )
}

describe('фокус в открытом окне', () => {
  beforeEach(() => resetOverlayStack())

  it('с последнего элемента Tab возвращается на первый, а не уходит наружу', async () => {
    const user = userEvent.setup()
    render(<Окно />)
    screen.getByText('последняя').focus()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByText('первая'))
  })

  it('Shift+Tab с первого элемента переходит на последний внутри окна', async () => {
    const user = userEvent.setup()
    render(<Окно />)
    screen.getByText('первая').focus()
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByText('последняя'))
  })
})
