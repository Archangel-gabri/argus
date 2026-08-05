// Знак провайдера рисуется в четырёх разделах сразу, и все четыре должны выглядеть одинаково:
// приглушённо-серым. Фирменный цвет остался ровно у одного места — крупного знака в панели
// деталей, где он один на экране. Проверка держит именно это разделение: стоит вернуть окраску
// «по умолчанию», и списки снова начнут пестрить, а цвет в приложении занят делом — им подписаны
// состояния, и цветной значок читается как «у этого что-то не так».
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ProviderMark } from './ProviderMark'
import { markFor } from '@/assets/providers/marks'

describe('ProviderMark', () => {
  it('по умолчанию наследует цвет текста и своего не назначает', () => {
    const { container } = render(<ProviderMark provider="Hetzner" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('fill', 'currentColor')
    expect(svg?.style.color).toBe('')
  })

  it('контуры не несут собственной заливки', () => {
    // Заливка на контуре сильнее currentColor у <svg>: один такой знак светился бы фирменным
    // цветом в ряду серых.
    const { container } = render(<ProviderMark provider="Ozon" />)
    for (const path of container.querySelectorAll('path')) expect(path.getAttribute('fill')).toBeNull()
  })

  it('фирменный цвет — только по явной просьбе', () => {
    const { container } = render(<ProviderMark provider="Hetzner" tinted />)
    // Сверяем не строку, а факт: браузерная модель переписывает `#d50c2d` в `rgb(213, 12, 45)`,
    // и сравнение с исходным написанием проверяло бы формат записи, а не поведение.
    const [r, g, b] = /(\d+), (\d+), (\d+)/.exec(container.querySelector('svg')?.style.color ?? '')?.slice(1) ?? []
    const tint = markFor('Hetzner')?.tint ?? ''
    expect([r, g, b].map(Number)).toEqual([1, 3, 5].map((i) => parseInt(tint.slice(i, i + 2), 16)))
  })

  it('без знака рисует монограмму того же размера', () => {
    // Ряд не должен рассыпаться на «с картинкой» и «без картинки»: у монограммы тот же габарит.
    const { container } = render(<ProviderMark provider="Ромашка-Хостинг" label="Ромашка" size={18} />)
    expect(container.querySelector('svg')).toBeNull()
    const glyph = container.querySelector('span')
    expect(glyph?.textContent).toBe('РО')
    expect(glyph?.style.width).toBe('18px')
  })
})
