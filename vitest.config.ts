import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Отдельный конфиг, а не electron.vite.config.ts: тестам не нужна сборка трёх бандлов,
// поэтому прогон не зависит от того, собирается ли приложение.
//
// Уровни разведены ПРОЕКТАМИ и различаются суффиксом файла:
//   *.test.ts        — unit: чистые разборщики и политики, среда node, счёт на миллисекунды
//   *.test.tsx       — dom:  компоненты и панели, среда jsdom
//   *.vault.test.ts  — интеграция с НАСТОЯЩИМ SQLCipher-файлом
//   *.net.test.ts    — интеграция с НАСТОЯЩИМ sshd в Docker
//   *.live.test.ts   — живой парк и внешние API, только по явному запуску
//
// ВАЖНО. `projects` разделяет конфигурацию, но НЕ меняет исполняемый файл и ABI процесса.
// Нативный модуль SQLCipher собран под Electron: под системным node он падает с
// ERR_DLOPEN_FAILED (проверено). Поэтому проект `vault` запускается ОТДЕЛЬНОЙ командой
// под `ELECTRON_RUN_AS_NODE=1 electron … vitest.mjs --project vault` — см. package.json.
// Запустить его вместе с остальными в одном процессе нельзя: это не неудобство, а невозможность.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.vault.test.ts', 'src/**/*.net.test.ts', 'src/**/*.live.test.ts'],
          // Явные импорты describe/it/expect вместо глобалей: тест-файл должен быть читаем
          // без знания о том, какие имена раннер подсунул в область видимости.
          globals: false
        }
      },
      {
        plugins: [react()],
        // Те же псевдонимы, что у сборки renderer (electron.vite.config.ts) — иначе `@/lib/cn`
        // не разрешится и компонент не импортируется.
        resolve: {
          alias: {
            '@renderer': resolve('src/renderer/src'),
            '@': resolve('src/renderer/src')
          }
        },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./test/setup-dom.ts'],
          globals: false
        }
      },
      {
        test: {
          name: 'vault',
          environment: 'node',
          include: ['src/**/*.vault.test.ts'],
          globals: false,
          // Хранилище — процессное состояние с одним соединением на модуль: параллельные
          // файлы дрались бы за него. Строго по одному.
          fileParallelism: false,
          testTimeout: 30_000
        }
      },
      {
        test: {
          name: 'net',
          environment: 'node',
          include: ['src/**/*.net.test.ts'],
          globals: false,
          testTimeout: 120_000,
          hookTimeout: 120_000
        }
      },
      {
        test: {
          name: 'live',
          environment: 'node',
          include: ['src/**/*.live.test.ts'],
          globals: false,
          testTimeout: 60_000
        }
      }
    ]
  }
})
