// Склейка проверяется ПО ЧИСЛУ реальных вызовов, а не по секундомеру: время до удалённого
// сервера скачет в разы, и на таком шуме измерение времени не доказывает ничего.
import { singleFlight, inFlightCount } from './single-flight'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ✔ ${name}`)
  else {
    failed++
    console.log(`  ✖ ${name}${extra !== undefined ? ` — получено: ${JSON.stringify(extra)}` : ''}`)
  }
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  // 1. Одновременные запросы по одному ключу = одна работа.
  let calls = 0
  const work = async (): Promise<string> => {
    calls++
    await delay(50)
    return 'результат'
  }
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => singleFlight('k', work)))
  check('пять одновременных запросов = одна работа', calls === 1, calls)
  check('все получили один и тот же ответ', all.every((r) => r === 'результат'))

  // 2. Разные ключи не смешиваются.
  calls = 0
  await Promise.all([singleFlight('a', work), singleFlight('b', work)])
  check('разные ключи выполняются раздельно', calls === 2, calls)

  // 3. Это склейка, а не кэш: после ответа следующий запрос делает работу заново.
  calls = 0
  await singleFlight('c', work)
  await singleFlight('c', work)
  check('после ответа работа выполняется заново (не кэш)', calls === 2, calls)

  // 4. Ошибка не оставляет ключ навсегда занятым — иначе одна неудача блокировала бы
  //    опрос устройства до перезапуска приложения.
  calls = 0
  const boom = async (): Promise<never> => {
    calls++
    await delay(10)
    throw new Error('сломалось')
  }
  const results = await Promise.allSettled([singleFlight('e', boom), singleFlight('e', boom)])
  check('ошибка тоже склеивается', calls === 1, calls)
  check('обе стороны получили отказ', results.every((r) => r.status === 'rejected'))
  check('ключ освободился после ошибки', inFlightCount() === 0, inFlightCount())
  calls = 0
  await singleFlight('e', boom).catch(() => undefined)
  check('после ошибки следующий запрос проходит', calls === 1, calls)

  // 5. Ничего не течёт.
  check('после всех запросов не осталось незакрытых работ', inFlightCount() === 0, inFlightCount())
}

void main().then(() => {
  console.log(failed === 0 ? '\nВСЁ СОШЛОСЬ' : `\nПРОВАЛОВ: ${failed}`)
  process.exit(failed === 0 ? 0 : 1)
})
