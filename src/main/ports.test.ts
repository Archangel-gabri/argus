// Проверка разборщиков портов на реальных форматах вывода sockstat (FreeBSD) и lsof (macOS).
// Машин с этими системами под рукой нет — поэтому образцы взяты ровно в том виде,
// в каком их печатают сами утилиты, вместе с ловушками:
//   • lsof на macOS печатает имена процессов С ПРОБЕЛАМИ («Google Chrome»);
//   • IPv6 в lsof идёт в скобках, в sockstat — без;
//   • у одного процесса много сокетов, а pid объявляется один раз на весь блок;
//   • tcp4 и tcp6 на один адрес — это один порт, а не два.
import { parseSockstat, parseLsof, parseAnyPorts, parseSs } from './ports'

let failed = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ✔ ${name}`)
  else {
    failed++
    console.log(`  ✖ ${name}${extra !== undefined ? ` — получено: ${JSON.stringify(extra)}` : ''}`)
  }
}

// ── FreeBSD: sockstat -46l ─────────────────────────────────────────────────────────────────────
const SOCKSTAT = `USER     COMMAND    PID   FD PROTO  LOCAL ADDRESS         FOREIGN ADDRESS
root     sshd       1234  4  tcp4   *:22                  *:*
root     sshd       1234  5  tcp6   *:22                  *:*
www      nginx      2001  6  tcp4   192.168.0.10:80       *:*
root     syslogd    900   7  udp4   127.0.0.1:514         *:*
root     ntpd       800   20 udp6   fe80::1%em0:123       *:*
root     kernel     0     0  icmp6  *:*                   *:*`

console.log('FreeBSD sockstat:')
{
  const p = parseSockstat(SOCKSTAT)
  check('заголовок не попал в результат', !p.some((x) => x.port === 0), p)
  check('tcp4+tcp6 на *:22 схлопнулись в один порт', p.filter((x) => x.port === 22).length === 1, p)
  check('имя и pid процесса разобраны', p.find((x) => x.port === 22)?.process === 'sshd', p.find((x) => x.port === 22))
  check('pid числом', p.find((x) => x.port === 22)?.pid === 1234)
  check('привязка *: считается wildcard', p.find((x) => x.port === 22)?.bind === 'wildcard')
  check('конкретный адрес — other', p.find((x) => x.port === 80)?.bind === 'other')
  check('127.0.0.1 — loopback', p.find((x) => x.port === 514)?.bind === 'loopback')
  check('udp распознан', p.find((x) => x.port === 514)?.proto === 'udp')
  check('зона IPv6 (%em0) отброшена', p.find((x) => x.port === 123)?.addr === 'fe80::1', p.find((x) => x.port === 123))
  check('icmp отброшен', !p.some((x) => x.port === 0), p)
  check('всего 4 порта (tcp4+tcp6 :22 — это один)', p.length === 4, p.map((x) => x.port))
  check('отсортировано по номеру', p[0].port === 22 && p[p.length - 1].port === 514, p.map((x) => x.port))
}

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

console.log('macOS lsof:')
{
  const p = parseLsof(LSOF)
  check('имя процесса с пробелом уцелело', p.find((x) => x.port === 7000)?.process === 'Google Chrome', p.find((x) => x.port === 7000))
  check('pid относится к своему блоку', p.find((x) => x.port === 7000)?.pid === 456)
  check('первый процесс не потерян', p.find((x) => x.port === 22)?.process === 'launchd')
  check('несколько сокетов одного процесса', p.filter((x) => x.pid === 1).length === 2, p.filter((x) => x.pid === 1))
  check('скобки вокруг IPv6 сняты', p.find((x) => x.port === 631)?.addr === '::1', p.find((x) => x.port === 631))
  check('::1 распознан как loopback', p.find((x) => x.port === 631)?.bind === 'loopback')
  check('установленное соединение (->) отброшено', !p.some((x) => x.port === 52310), p)
  check('udp распознан', p.find((x) => x.port === 5353)?.proto === 'udp')
  check('всего 4 слушающих сокета', p.length === 4, p.map((x) => `${x.proto}/${x.port}`))
}

// ── Автоопределение формата ────────────────────────────────────────────────────────────────────
const SS = `tcp   LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=700,fd=3))
udp   UNCONN 0      0          127.0.0.53:53         0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=12))`

console.log('Автоопределение формата:')
{
  check('lsof узнан по строке-pid', parseAnyPorts(LSOF).length === 4)
  check('sockstat узнан по колонке proto', parseAnyPorts(SOCKSTAT).length === 4)
  check('ss узнан (ветка по умолчанию)', parseAnyPorts(SS).length === 2, parseAnyPorts(SS))
  check('разбор ss не сломан', parseSs(SS)[0].process === 'sshd', parseSs(SS)[0])
  check('пустой ввод — пустой список, без падения', parseAnyPorts('').length === 0)
  check('мусор не притворяется портами', parseAnyPorts('bash: ss: command not found').length === 0)
}

console.log(failed === 0 ? '\nВСЁ СОШЛОСЬ' : `\nПРОВАЛОВ: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
