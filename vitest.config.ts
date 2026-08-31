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
// Нативный модуль SQLCipher должен быть пересобран под Electron (`npm run rebuild`;
// `check:full` и `dist` делают это сами): под системным node он после этого падает с
// ERR_DLOPEN_FAILED (проверено). Поэтому проект `vault` запускается ОТДЕЛЬНОЙ командой
// под `ELECTRON_RUN_AS_NODE=1 electron … vitest.mjs --project vault` — см. package.json.
// Запустить его вместе с остальными в одном процессе нельзя: это не неудобство, а невозможность.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Считаем ВЕСЬ боевой код, а не только тот, куда тест уже дошёл: иначе цифра растёт от
      // удаления тестов и ничего не значит. В vitest 4 это поведение задаётся самим `include`
      // (прежний ключ `all` убран — и он молча ничего не делал, пока конфиг не попал под tsc).
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        // Точки входа и разметка: их поведение проверяется E2E на живом приложении, а не
        // построчным покрытием — здесь оно мерило длины файла, а не проверенности.
        'src/renderer/src/main.tsx',
        'src/renderer/src/screen-main.tsx',
        'src/renderer/src/assets/**',
        'src/main/sqlite.d.ts',
        'src/main/vendor.d.ts'
      ],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage'
    },
    projects: [
      {
        // Псевдонимы нужны и здесь: файлы renderer/lib и renderer/store — обычный TypeScript
        // без разметки, их место в быстром прогоне, а ссылаются они через `@`.
        resolve: {
          alias: {
            '@renderer': resolve('src/renderer/src'),
            '@': resolve('src/renderer/src')
          }
        },
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
