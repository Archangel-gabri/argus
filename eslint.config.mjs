// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// Линтера в проекте не было вовсе. Набор правил подобран не «по умолчанию», а под цену ошибки
// именно здесь: приложение распоряжается ключами, деньгами и питанием чужих машин, и почти все
// его отказы — тихие. Поэтому включены правила про НЕДОСМОТРЕННЫЕ промисы и подавленные ошибки,
// а стилистика оставлена форматтеру.
export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'resources/**',
      'assets/**',
      'test-results/**',
      'playwright-report/**',
      'agent/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      // ── То, ради чего линтер здесь и стоит ────────────────────────────────────────────────
      // Незамеченный промис — это ровно тот класс, что дал D2: операция «идёт», её результата
      // никто не ждёт, отказ никуда не всплывает.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `await` на не-промисе обычно означает потерянный вызов или неверную сигнатуру.
      '@typescript-eslint/await-thenable': 'error',
      // Приведение unknown к типу без проверки на границе IPC — источник падений в main.
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',

      // ── Шум, который правилами не лечится ────────────────────────────────────────────────
      // Пустой catch здесь осознан и всегда прокомментирован: cleanup обязан быть best-effort,
      // иначе одно сломанное соединение мешает закрыть остальные.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/require-await': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Пропущенная зависимость эффекта в этом приложении означает интерфейс, застывший на
      // старых показаниях, — то есть ту же тихую ложь состояния.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // В тестах намеренно подсовываются заведомо неверные значения — правила про типобезопасность
    // тут только мешают.
    files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off'
    }
  }
)
