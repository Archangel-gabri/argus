import { describe, it, expect } from 'vitest'
import { isGeoResolvable, hostForUrl } from './ip-privacy'

// Регрессия на реальный дефект: наружу, на публичный ipwho.is, могли уехать адреса и имена
// внутренней сети. Проверок было две, в разных редакциях, и та, что стоит за IPC-каналом
// net:ipLookup, была слабее.
describe('isGeoResolvable — что НЕЛЬЗЯ отправлять наружу', () => {
  it('частные сети RFC1918', () => {
    for (const ip of ['10.0.0.9', '172.16.0.1', '172.31.255.254', '192.168.0.1']) {
      expect(isGeoResolvable(ip)).toBe(false)
    }
  })

  it('loopback, link-local и «этот хост»', () => {
    for (const ip of ['127.0.0.1', '169.254.10.10', '0.0.0.0', '0.1.2.3']) {
      expect(isGeoResolvable(ip)).toBe(false)
    }
  })

  it('CGNAT 100.64/10 — в нём живёт Tailscale', () => {
    for (const ip of ['100.64.0.1', '100.79.101.69', '100.127.255.255']) {
      expect(isGeoResolvable(ip)).toBe(false)
    }
    // А это уже публичный 100.x, он за границей диапазона.
    expect(isGeoResolvable('100.128.0.1')).toBe(true)
    expect(isGeoResolvable('100.63.255.255')).toBe(true)
  })

  it('multicast, зарезервированное и broadcast', () => {
    for (const ip of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
      expect(isGeoResolvable(ip)).toBe(false)
    }
  })

  it('документационные и тестовые диапазоны', () => {
    for (const ip of ['192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1']) {
      expect(isGeoResolvable(ip)).toBe(false)
    }
  })

  it('приватный адрес В ЗАПИСИ IPv6 — тот же адрес, другая форма', () => {
    // Прежний фильтр сравнивал префиксы строки и эту форму пропускал.
    expect(isGeoResolvable('::ffff:10.0.0.7')).toBe(false)
    expect(isGeoResolvable('::ffff:192.168.1.1')).toBe(false)
    expect(isGeoResolvable('::ffff:127.0.0.1')).toBe(false)
    expect(isGeoResolvable('::10.0.0.7')).toBe(false)
  })

  it('непубличные диапазоны IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', 'ff02::1']) {
      expect(isGeoResolvable(ip)).toBe(false)
    }
  })

  it('ИМЯ ХОСТА — не адрес, и раскрывать его наружу незачем', () => {
    for (const name of ['router.corp', 'localhost', 'nas.local', 'vm4353523.firstbyte.club', 'пример.рф']) {
      expect(isGeoResolvable(name)).toBe(false)
    }
  })

  it('мусор и заглушки', () => {
    for (const bad of ['', '   ', 'x.x.x.x', '10.0.0.x', '999.1.1.1', '1.2.3', '1.2.3.4.5']) {
      expect(isGeoResolvable(bad)).toBe(false)
    }
  })
})

describe('isGeoResolvable — что отправлять МОЖНО', () => {
  it('настоящие публичные адреса флота', () => {
    for (const ip of ['46.17.107.87', '104.156.154.204', '8.8.8.8', '1.1.1.1']) {
      expect(isGeoResolvable(ip)).toBe(true)
    }
  })

  it('публичный IPv6', () => {
    expect(isGeoResolvable('2606:4700:4700::1111')).toBe(true)
    expect(isGeoResolvable('2001:4860:4860::8888')).toBe(true)
  })

  it('пробелы по краям не мешают', () => {
    expect(isGeoResolvable('  8.8.8.8  ')).toBe(true)
  })
})

// Регрессия на реальный дефект: адрес агента собирался как `wss://${host}:47990/stream`, и на
// IPv6 это давало не адрес, а мусор — new URL бросал Invalid URL, окно трансляции не открывалось.
describe('hostForUrl', () => {
  it('литерал IPv6 берётся в квадратные скобки', () => {
    expect(hostForUrl('fd00::1')).toBe('[fd00::1]')
    expect(hostForUrl('2606:4700:4700::1111')).toBe('[2606:4700:4700::1111]')
  })

  it('собранный адрес после этого разбирается', () => {
    expect(() => new URL(`wss://${hostForUrl('fd00::1')}:47990/stream`)).not.toThrow()
    // А без скобок — именно та ошибка, из-за которой всё и ломалось.
    expect(() => new URL('wss://fd00::1:47990/stream')).toThrow()
  })

  it('IPv4 и имена хостов не трогаются', () => {
    expect(hostForUrl('100.74.94.24')).toBe('100.74.94.24')
    expect(hostForUrl('castiel-pc')).toBe('castiel-pc')
  })

  it('уже заскобленный адрес не обрастает второй парой', () => {
    expect(hostForUrl('[fd00::1]')).toBe('[fd00::1]')
  })

  it('пустая строка остаётся пустой', () => {
    expect(hostForUrl('')).toBe('')
    expect(hostForUrl('   ')).toBe('')
  })
})
