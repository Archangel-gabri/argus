// Матчеры вида toBeInTheDocument / toHaveAttribute для проекта `dom`.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Каждый тест начинает с чистого документа: иначе смонтированное предыдущим тестом дерево
// остаётся в DOM и запросы вроде getByRole находят два элемента вместо одного.
afterEach(() => cleanup())
