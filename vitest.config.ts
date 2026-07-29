import { defineConfig } from 'vitest/config'

// Отдельный конфиг, а не electron.vite.config.ts: тесты проверяют ЧИСТЫЕ разборщики и утилиты
// main-процесса, им не нужен ни Electron, ни сборка трёх бандлов. Так прогон остаётся быстрым
// и не зависит от того, собирается ли приложение.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Явные импорты describe/it/expect вместо глобалей: тест-файл должен быть читаем без
    // знания о том, какие имена раннер подсунул в область видимости.
    globals: false,
    reporters: ['default'],
  },
})
