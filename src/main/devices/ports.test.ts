// Проверка разборщиков портов на реальных форматах вывода sockstat (FreeBSD) и lsof (macOS).
// Машин с этими системами под рукой нет — поэтому образцы взяты ровно в том виде,
// в каком их печатают сами утилиты, вместе с ловушками:
//   • lsof на macOS печатает имена процессов С ПРОБЕЛАМИ («Google Chrome»);
//   • IPv6 в lsof идёт в скобках, в sockstat — без;
//   • у одного процесса много сокетов, а pid объявляется один раз на весь блок;
//   • tcp4 и tcp6 на один адрес — это один порт, а не два.
import { describe, it, expect } from 'vitest'
import { parseSockstat, parseLsof, parseAnyPorts, parseSs } from './ports'

// ── FreeBSD: sockstat -46l ─────────────────────────────────────────────────────────────────────
const SOCKSTAT = `USER     COMMAND    PID   FD PROTO  LOCAL ADDRESS         FOREIGN ADDRESS
root     sshd       1234  4  tcp4   *:22                  *:*
root     sshd       1234  5  tcp6   *:22                  *:*
www      nginx      2001  6  tcp4   192.168.0.10:80       *:*
root     syslogd    900   7  udp4   127.0.0.1:514         *:*
root     ntpd       800   20 udp6   fe80::1%em0:123       *:*
root     kernel     0     0  icmp6  *:*                   *:*`

describe('parseSockstat — FreeBSD', () => {
  const p = parseSockstat(SOCKSTAT)
  const at = (port: number): (typeof p)[number] | undefined => p.find((x) => x.port === port)

  it('заголовок не попал в результат', () => {
    expect(p.some((x) => x.port === 0)).toBe(false)
  })

  it('tcp4+tcp6 на *:22 схлопнулись в один порт', () => {
    expect(p.filter((x) => x.port === 22)).toHaveLength(1)
  })

  it('имя и pid процесса разобраны', () => {
    expect(at(22)?.process).toBe('sshd')
    expect(at(22)?.pid).toBe(1234)
  })

  it('привязка *: считается wildcard', () => {
    expect(at(22)?.bind).toBe('wildcard')
  })

  it('конкретный адрес — other', () => {
    expect(at(80)?.bind).toBe('other')
  })

  it('127.0.0.1 — loopback, протокол udp', () => {
    expect(at(514)?.bind).toBe('loopback')
    expect(at(514)?.proto).toBe('udp')
  })

  it('зона IPv6 (%em0) отброшена', () => {
    expect(at(123)?.addr).toBe('fe80::1')
  })

  it('всего 4 порта (tcp4+tcp6 :22 — это один), icmp отброшен', () => {
    expect(p.map((x) => x.port)).toHaveLength(4)
  })

  it('отсортировано по номеру', () => {
    expect(p[0].port).toBe(22)
    expect(p[p.length - 1].port).toBe(514)
  })
})

// ── macOS: lsof -F ─────────────────────────────────────────────────────────────────────────────
// Ключевой случай — «Google Chrome»: в колоночном выводе пробел в имени сдвигает все поля.
const LSOF = `p1
claunchd
f7
PTCP
n*:22
f9
PTCP
n[::1]:631
p456
cGoogle Chrome
f23
PTCP
n127.0.0.1:7000
f24
PTCP
n192.168.1.5:52310->17.253.144.10:443
p789
cmDNSResponder
f10
PUDP
n*:5353`

describe('parseLsof — macOS', () => {
  const p = parseLsof(LSOF)
  const at = (port: number): (typeof p)[number] | undefined => p.find((x) => x.port === port)

  it('имя процесса с пробелом уцелело', () => {
    expect(at(7000)?.process).toBe('Google Chrome')
  })

  it('pid относится к своему блоку', () => {
    expect(at(7000)?.pid).toBe(456)
  })

  it('первый процесс не потерян', () => {
    expect(at(22)?.process).toBe('launchd')
  })

  it('несколько сокетов одного процесса', () => {
    expect(p.filter((x) => x.pid === 1)).toHaveLength(2)
  })

  it('скобки вокруг IPv6 сняты, ::1 — loopback', () => {
    expect(at(631)?.addr).toBe('::1')
    expect(at(631)?.bind).toBe('loopback')
  })

  it('установленное соединение (->) отброшено', () => {
    expect(p.some((x) => x.port === 52310)).toBe(false)
  })

  it('udp распознан', () => {
    expect(at(5353)?.proto).toBe('udp')
  })

  it('всего 4 слушающих сокета', () => {
    expect(p).toHaveLength(4)
  })
})

// ── Автоопределение формата ────────────────────────────────────────────────────────────────────
const SS = `tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=700,fd=3))
udp   UNCONN 0      0          127.0.0.53:53         0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=12))`

describe('parseAnyPorts — формат определяется по самому выводу', () => {
  it('lsof узнан по строке-pid', () => {
    expect(parseAnyPorts(LSOF)).toHaveLength(4)
  })

  it('sockstat узнан по колонке proto', () => {
    expect(parseAnyPorts(SOCKSTAT)).toHaveLength(4)
  })

  it('ss узнан (ветка по умолчанию)', () => {
    expect(parseAnyPorts(SS)).toHaveLength(2)
  })

  it('разбор ss не сломан', () => {
    expect(parseSs(SS)[0].process).toBe('sshd')
  })

  it('пустой ввод — пустой список, без падения', () => {
    expect(parseAnyPorts('')).toHaveLength(0)
  })

  it('мусор не притворяется портами', () => {
    expect(parseAnyPorts('bash: ss: command not found')).toHaveLength(0)
  })
})
