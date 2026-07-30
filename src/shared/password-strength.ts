import type { ZxcvbnResult } from '@zxcvbn-ts/core'

export type { ZxcvbnResult }

/** Минимальный допустимый score общий для renderer и авторитетной IPC-проверки в main. */
export const MIN_PASSWORD_SCORE = 3

// У zxcvbn-ts нет русского языкового пакета. Без этого списка фразы вроде «один два три»
// оценивались на 4/4: библиотека принимала кириллицу за случайный алфавит высокой энтропии.
const COMMON_RUSSIAN_WORDS = [
  'пароль', 'секрет', 'логин', 'админ', 'администратор', 'доступ', 'мастер', 'ключ',
  'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
  'ноль', 'первый', 'второй', 'третий', 'последний', 'новый', 'старый',
  'мама', 'папа', 'сын', 'дочь', 'семья', 'любовь', 'друг', 'кот', 'кошка', 'собака',
  'дом', 'работа', 'школа', 'город', 'москва', 'россия', 'привет', 'спасибо',
  'красный', 'синий', 'зеленый', 'белый', 'черный', 'лето', 'зима', 'весна', 'осень',
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь',
  'октябрь', 'ноябрь', 'декабрь', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница',
  'суббота', 'воскресенье', 'мыла', 'раму', 'мир', 'счастье', 'солнце', 'звезда',
  'йцукен', 'фыва', 'ячсмить'
] as const

const commonRussian = new Set<string>(COMMON_RUSSIAN_WORDS)
const weakAsSingleWord = new Set(['пароль', 'секрет', 'админ', 'администратор', 'йцукен', 'ячсмить'])

function normalizeRussian(password: string): string {
  return password.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/[^а-я]/g, '')
}

/** True, если вся кириллическая часть раскладывается на банальные словарные слова. */
function isWeakRussianPhrase(password: string): boolean {
  const normalized = normalizeRussian(password)
  if (normalized.length < 4) return false
  if (weakAsSingleWord.has(normalized)) return true

  // DP нужен не ради академичности: пользователь может написать «одиндватри» без пробелов,
  // и английский zxcvbn как раз ошибочно считал такую строку сильной.
  const words = new Array<number>(normalized.length + 1).fill(-1)
  words[0] = 0
  for (let i = 0; i < normalized.length; i += 1) {
    if (words[i] < 0) continue
    for (const word of commonRussian) {
      if (normalized.startsWith(word, i)) {
        const end = i + word.length
        words[end] = Math.max(words[end], words[i] + 1)
      }
    }
  }
  return words[normalized.length] >= 2
}

type Factory = { check: (password: string) => ZxcvbnResult }
let factoryPromise: Promise<Factory> | null = null

async function getFactory(): Promise<Factory> {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      const [core, common, en] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en')
      ])
      return new core.ZxcvbnFactory({
        dictionary: {
          ...common.dictionary,
          ...en.dictionary,
          'commonWords-ru': [...COMMON_RUSSIAN_WORDS]
        },
        graphs: common.adjacencyGraphs,
        translations: en.translations
      })
    })()
  }
  return factoryPromise
}

export async function checkStrength(password: string): Promise<ZxcvbnResult> {
  const factory = await getFactory()
  const result = factory.check(password)
  if (!isWeakRussianPhrase(password)) return result

  // Подменяем только оценочную часть результата на известный слабый словарный пароль.
  // Поле password/sequence остаётся от фактического ввода, а UI больше не показывает
  // «взлом через столетия» рядом с отклонённой общеизвестной фразой.
  const weak = factory.check('password')
  return {
    ...result,
    guesses: weak.guesses,
    guessesLog10: weak.guessesLog10,
    crackTimes: weak.crackTimes,
    score: weak.score,
    feedback: {
      warning: 'Это распространённые русские слова.',
      suggestions: ['Возьми более редкую фразу из 4 или больше слов.']
    }
  }
}

export async function masterPasswordPolicyError(password: string): Promise<string | null> {
  if (password.length < 6) return 'Пароль — минимум 6 символов'
  if ((await checkStrength(password)).score < MIN_PASSWORD_SCORE)
    return 'Пароль слишком слабый — возьми более редкую фразу из 4 или больше слов'
  return null
}

function plural(value: number, one: string, few: string, many: string): string {
  const mod100 = value % 100
  const mod10 = value % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/** Локализованный эквивалент zxcvbn display для строки онбординга. */
export function formatCrackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return 'меньше секунды'
  const units: Array<[number, string, string, string]> = [
    [365 * 24 * 60 * 60, 'года', 'лет', 'лет'],
    [30 * 24 * 60 * 60, 'месяца', 'месяцев', 'месяцев'],
    [24 * 60 * 60, 'дня', 'дней', 'дней'],
    [60 * 60, 'часа', 'часов', 'часов'],
    [60, 'минуты', 'минут', 'минут'],
    [1, 'секунды', 'секунд', 'секунд']
  ]
  const [unit, one, few, many] = units.find(([size]) => seconds >= size) ?? units.at(-1)!
  const value = Math.max(1, Math.round(seconds / unit))
  return `около ${value} ${plural(value, one, few, many)}`
}
