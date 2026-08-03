import { describe, expect, it } from 'vitest'
import { parseEnvFile } from './ai-seed'

// Файл ключей владельца пишется руками: там встречаются и export, и кавычки, и комментарии.
// Ошибка разбора здесь тихо оставляет доступ без ключа — с виду всё завелось, а проверка
// показывает «нет ключа».
describe('разбор env-файла с ключами', () => {
  it('берёт пары ключ-значение и не спотыкается о комментарии и пустые строки', () => {
    const env = parseEnvFile('# ключи\n\nTAVILY_API_KEY=tvly-123\n\n# конец\nEXA_API_KEY=exa-456\n')
    expect(env).toEqual({ TAVILY_API_KEY: 'tvly-123', EXA_API_KEY: 'exa-456' })
  })

  it('снимает export и кавычки, но не трогает содержимое значения', () => {
    const env = parseEnvFile(`export A="value-with-dash"\nB='single'\nC=no-quotes\n`)
    expect(env).toEqual({ A: 'value-with-dash', B: 'single', C: 'no-quotes' })
  })

  it('значение со знаком равенства внутри остаётся целым', () => {
    // База64 и URL с параметрами — обычное дело для ключей; резать по первому «=» обязательно.
    expect(parseEnvFile('K=abc=def==')).toEqual({ K: 'abc=def==' })
  })

  it('строки без имени переменной игнорируются', () => {
    expect(parseEnvFile('=пусто\nпросто текст\n')).toEqual({})
  })
})
