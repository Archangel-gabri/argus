import { describe, it, expect } from 'vitest'
import { remoteFamily, remoteArch } from './os-family'

describe('remoteFamily', () => {
  it('Windows определяется до всякого uname', () => {
    expect(remoteFamily(true, '')).toBe('windows')
    expect(remoteFamily(true, 'Darwin arm64')).toBe('windows')
  })

  it('различает семьи по ответу uname -s', () => {
    expect(remoteFamily(false, 'Darwin\narm64')).toBe('darwin')
    expect(remoteFamily(false, 'FreeBSD\namd64')).toBe('freebsd')
    expect(remoteFamily(false, 'Linux\nx86_64')).toBe('linux')
  })

  it('регистр ответа значения не имеет', () => {
    expect(remoteFamily(false, 'DARWIN')).toBe('darwin')
    expect(remoteFamily(false, '  darwin  ')).toBe('darwin')
  })

  it('молчание машины считает Linux — самая безобидная из ошибок', () => {
    // На незнакомой машине linux-ветка просто не найдёт, что удалять; ошибиться в другую
    // сторону дороже: launchd-ветка на Linux ничего не остановит.
    expect(remoteFamily(false, '')).toBe('linux')
    expect(remoteFamily(false, '   ')).toBe('linux')
  })
})

describe('remoteArch', () => {
  it('узнаёт arm по обоим написаниям', () => {
    expect(remoteArch('Darwin arm64')).toBe('arm64')
    expect(remoteArch('Linux aarch64')).toBe('arm64')
  })

  it('всё остальное — amd64', () => {
    expect(remoteArch('Linux x86_64')).toBe('amd64')
    expect(remoteArch('')).toBe('amd64')
  })
})
