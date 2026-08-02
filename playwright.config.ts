import { defineConfig } from '@playwright/test'

// E2E поднимает НАСТОЯЩЕЕ приложение — собранное, из out/, тем же кодом, что уезжает в AppImage.
//
// Ценность здесь не в кликах по кнопкам: `electronApp.evaluate()` пускает тест прямо в
// main-процесс, поэтому можно дёргать ipcMain и проверять инварианты изнутри — то, что через
// интерфейс не увидеть вовсе (заголовки CSP, блокировка навигации, состав моста).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // Одно приложение на весь прогон: параллельные Electron дрались бы за каталог userData.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  // Приложение должно быть собрано: гоняем ровно то, что уедет пользователю.
  globalSetup: './e2e/global-setup.ts'
})
