import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * E2E запускает СОБРАННОЕ приложение, а не исходники. Если out/ нет или он старее исходников,
 * тест проверял бы не то, что уедет пользователю, — поэтому сборка здесь обязательна.
 */
export default function globalSetup(): void {
  const root = join(__dirname, '..')
  const entry = join(root, 'out', 'main', 'index.js')
  if (existsSync(entry) && process.env.ARGUS_E2E_SKIP_BUILD === '1') return
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
}
