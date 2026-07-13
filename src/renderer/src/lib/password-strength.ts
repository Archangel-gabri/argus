// Ленивая обёртка над zxcvbn: словари (сотни КБ) грузятся динамическим импортом ТОЛЬКО
// при первой проверке (первичная настройка / смена пароля), а не на каждом старте —
// возвращающийся пользователь на unlock их не тянет.
import type { ZxcvbnResult } from '@zxcvbn-ts/core'

export type { ZxcvbnResult }

/** Минимальный допустимый скор (crack-time), общий для онбординга и смены пароля. */
export const MIN_PASSWORD_SCORE = 3

type Factory = { check: (pw: string) => ZxcvbnResult }
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
        dictionary: { ...common.dictionary, ...en.dictionary },
        graphs: common.adjacencyGraphs,
        translations: en.translations
      })
    })()
  }
  return factoryPromise
}

export async function checkStrength(pw: string): Promise<ZxcvbnResult> {
  return (await getFactory()).check(pw)
}
