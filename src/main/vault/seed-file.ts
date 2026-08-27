// Где приложение ищет файлы засева.
//
// Раньше искали в двух местах: рядом с кодом (`app.getAppPath()`) и в рабочем каталоге. Оба
// работают только при запуске из каталога проекта — а в собранный AppImage эти файлы не входят
// (в сборку кладутся `out/**` и `package.json`), и рабочий каталог у него тот, откуда его
// запустили, обычно домашний. Установленное приложение засев просто не выполняло, и это было
// незаметно: данные, засеянные раньше при разработке, уже лежали в хранилище и выглядели как
// доказательство, что всё работает.
//
// Поэтому первым проверяется каталог данных приложения — единственное место, которое одинаково
// доступно и установленной копии, и запущенной из исходников.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Каталоги-кандидаты по убыванию надёжности. Отдельная функция — чтобы её было видно в тестах. */
export function seedDirs(paths: { userData?: string; appPath?: string; cwd: string }): string[] {
  const out: string[] = []
  if (paths.userData) out.push(paths.userData)
  if (paths.appPath) out.push(paths.appPath)
  out.push(paths.cwd)
  return out
}

/** Найти файл засева по имени. null — файла нет нигде, и это нормальная ситуация. */
export function findSeedFile(name: string): string | null {
  let userData: string | undefined
  let appPath: string | undefined
  try {
    userData = app.getPath('userData')
  } catch {
    /* вне Electron каталога данных нет */
  }
  try {
    appPath = app.getAppPath()
  } catch {
    /* путь приложения недоступен */
  }
  return seedDirs({ userData, appPath, cwd: process.cwd() })
    .map((dir) => join(dir, name))
    .find((p) => existsSync(p)) ?? null
}
