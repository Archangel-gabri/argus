// Разбор ошибок guacd. guacd сообщает о сбое инструкцией "error" → Guacamole.Status {code, message}.
// Общий модуль: им пользуются и окно экрана, и вкладка-пусковая площадка.
export interface GuacStatus {
  code?: number
  message?: string
}

const GUAC_ERR: Record<number, string> = {
  0x0201: 'Сервер занят — попробуй ещё раз.',
  0x0202: 'ПК не ответил вовремя (таймаут сети).',
  0x0203: 'Ошибка на стороне ПК при RDP-подключении.',
  0x0207: 'RDP на ПК не отвечает — удалённый рабочий стол выключен?',
  0x0208: 'RDP недоступен: порт 3389 закрыт или служба не поднята.',
  0x0209: 'Сеанс уже занят другим подключением.',
  0x020a: 'Сеанс закрыт по таймауту бездействия.',
  0x020b: 'Сеанс закрыт на стороне ПК.',
  0x0300: 'Некорректный запрос к RDP.',
  0x0301: 'Неверный пароль Windows-аккаунта — RDP отклонил вход (NLA).',
  0x0303: 'Этому аккаунту запрещён вход по RDP.',
  0x0308: 'Вход не подтверждён вовремя.'
}

/** Ошибка авторизации? Переподключаться при ней НЕЛЬЗЯ — долбили бы RDP неверным паролем. */
export function isAuthFailure(s?: GuacStatus): boolean {
  return s?.code === 0x0301 || s?.code === 0x0303 || /auth|credential|logon/i.test(s?.message ?? '')
}

export function guacErr(s?: GuacStatus): string {
  const msg = s?.message ?? ''
  if (/auth|credential|logon/i.test(msg))
    return 'Неверный пароль Windows-аккаунта — RDP отклонил вход (NLA).'
  const known = s?.code != null ? GUAC_ERR[s.code] : undefined
  if (known) return known
  return msg ? `Ошибка RDP: ${msg}` : 'Ошибка RDP-соединения'
}
