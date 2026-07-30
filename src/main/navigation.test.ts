import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl } from './navigation'

describe('внешняя навигация окон', () => {
  it.each([
    'https://console.example.com/server/1',
    'http://127.0.0.1:8080/'
  ])('разрешает обычную веб-ссылку %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true)
  })

  it.each([
    'javascript:alert(document.cookie)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vscode://file/etc/passwd',
    'не URL'
  ])('не передаёт опасную схему операционной системе: %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false)
  })
})
