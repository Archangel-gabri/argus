#!/usr/bin/env node
// Перекрасить чужой логотип в наш цвет.
//
// Задача владельца звучала так: «скрипт, который парсит ярлыки — хоть реддита, хоть чего — и
// окрашивает в наш цвет; у нас по ИИ всё серое». Для векторов это делается само (знак рисуется
// `currentColor`), но у части хостеров свободного вектора нет вовсе, и остаётся растр. Растр
// покрасить нельзя ни классом, ни CSS-фильтром: у четырёх логотипов из пяти фон НЕПРОЗРАЧНЫЙ,
// и `invert` превращает такой файл в белый квадрат.
//
// Сам алгоритм живёт в `src/shared/png-mono.ts` — тот же, которым приложение красит значки,
// скачанные с сайтов компаний. Node снимает типы на лету (v23+), сборка для запуска не нужна.
//
//   node tools/monochrome-logo.mjs <вход.png> <выход.png> [--color "#94a3b8"] [--threshold 0.06]

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Расширение `.mts`, а не `.ts`: у проекта `"type": "commonjs"`, и обычный `.ts` Node считает
// модулем CommonJS — он падает на первом же `import` внутри. `.mts` однозначно говорит «это
// ESM», типы Node снимает сам (v23+), и сборка для запуска инструмента не нужна.
import { decodePng, encodePng, monochrome } from '../src/shared/png-mono.mts'

function main() {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
  if (files.length < 2) {
    console.error('нужно: node tools/monochrome-logo.mjs <вход.png> <выход.png> [--color "#94a3b8"] [--threshold 0.06]')
    process.exit(2)
  }
  const hex = flag('--color', '#94a3b8').replace('#', '')
  const color = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const res = monochrome(decodePng(readFileSync(files[0])), { color, threshold: Number(flag('--threshold', 0.06)) })
  const share = res.ink / (res.width * res.height)
  // Пустой или сплошной силуэт — это не логотип, а сбой распознавания фона. Молча записать
  // такой файл значит подменить знак квадратом и увидеть это только глазами в приложении.
  if (share < 0.01) throw new Error(`${files[0]}: краски почти нет (${(share * 100).toFixed(1)}%) — фон определился неверно`)
  if (share > 0.95) throw new Error(`${files[0]}: закрашено ${(share * 100).toFixed(0)}% — фон не вычелся, вышел бы квадрат`)
  writeFileSync(files[1], encodePng(res))
  console.log(
    `${files[0]} → ${files[1]}: ${res.width}×${res.height}, краски ${(share * 100).toFixed(1)}%, ` +
      `фон ${res.hadBackground ? 'вычтен' : 'прозрачный, взята альфа'}`
  )
}

// Сравнивать с `file://${argv[1]}` нельзя: путь проекта содержит пробел и кириллицу, в
// import.meta.url они percent-кодированы, строки не совпадают — и скрипт молча ничего не делает.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
