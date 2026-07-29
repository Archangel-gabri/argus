// Проверка разборщиков macOS и FreeBSD на РЕАЛЬНЫХ форматах вывода.
//
// Живых машин с этими системами под рукой нет, поэтому единственный честный способ убедиться,
// что разбор верен, — прогнать его на образцах вывода ровно в том виде, в каком его печатают
// сами утилиты. Форматы взяты из man-страниц и известных особенностей:
//   • netstat печатает строку <Link#N> плюс по строке на каждый адрес — суммировать всё нельзя;
//   • df -k -P отдаёт килобайты (без -k на BSD это блоки по 512 байт);
//   • vm_stat объявляет размер страницы в заголовке — 16К на Apple Silicon, 4К на Intel;
//   • у top на macOS первый замер всегда невалидный, брать надо второй.
import { describe, it, expect } from 'vitest'
import { parseFreeBsd, parseDarwin } from './metrics-bsd'

// ── FreeBSD ────────────────────────────────────────────────────────────────────────────────────
// 4 ядра. Между замерами: idle вырос на 300 из 400 тиков ⇒ занятость 25%.
const FREEBSD_OUT = `@@C1
100 0 50 0 1000
@@CC1
25 0 12 0 250 25 0 12 0 250 25 0 13 0 250 25 0 13 0 250
@@N1
Name    Mtu Network       Address              Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
vtnet0 1500 <Link#1>      52:54:00:12:34:56     1000     0    1000000      900     0     500000     0
vtnet0    - 192.168.0.0   192.168.0.10           500     -     400000      400     -     200000     -
lo0   16384 <Link#2>                              10     0       2000       10     0       2000     0
@@C2
150 0 100 0 1300
@@CC2
37 0 25 0 325 38 0 25 0 325 37 0 25 0 325 38 0 25 0 325
@@N2
Name    Mtu Network       Address              Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
vtnet0 1500 <Link#1>      52:54:00:12:34:56     1100     0    1070000      950     0     535000     0
vtnet0    - 192.168.0.0   192.168.0.10           550     -     440000      420     -     220000     -
lo0   16384 <Link#2>                              10     0       2000       10     0       2000     0
@@MEM
8589934592
4096
524288
262144
0
@@SWAP
Device          1K-blocks     Used    Avail Capacity
/dev/gpt/swapfs   2097152   524288  1572864    25%
@@LOAD
{ 0.42 0.35 0.30 }
@@UP
{ sec = 1750000000, usec = 0 } Fri Jun 15 12:00:00 2026
1750086400
@@MOUNTS
Filesystem   1024-blocks     Used    Avail Capacity  Mounted on
/dev/gpt/rootfs  20971520  8388608 12582912    40%    /
devfs                   1        1        0   100%    /dev
@@TEMP
45.0C
@@TOP
%CPU %MEM COMMAND
12.5  3.2 nginx
 4.0  1.1 sshd
@@END`

describe('parseFreeBsd', () => {
  const m = parseFreeBsd(FREEBSD_OUT)

  it('CPU считается из дельты накопительных счётчиков', () => {
    // idle 1000→1300 (+300), сумма 1150→1550 (+400) ⇒ занято (400-300)/400 = 25%
    expect(m.cpu).toBe(25)
  })

  it('видит все 4 ядра', () => {
    expect(m.cores).toHaveLength(4)
  })

  it('загрузка системы', () => {
    expect(m.load[0]).toBe(0.42)
    expect(m.load[2]).toBe(0.3)
  })

  it('память: всего 8 ГБ, занято 5 ГБ', () => {
    // свободно (524288+262144+0) страниц × 4096 = 3 ГБ ⇒ занято 5 ГБ
    expect(m.ramTotal).toBe(8)
    expect(m.ramUsed).toBe(5)
  })

  it('подкачка 2 ГБ, занято 0.5 ГБ', () => {
    expect(m.swapTotal).toBe(2)
    expect(m.swapUsed).toBe(0.5)
  })

  it('сеть считается без задваивания по адресам', () => {
    // ТОЛЬКО Link-строки: (1070000-1000000 + 0) / 0.7 = 100000
    expect(m.netRx).toBe(100000)
    expect(m.netTx).toBe(50000)
  })

  it('корень занят на 40%, служебные ФС отброшены', () => {
    expect(m.disk).toBe(40)
    expect(m.mounts).toHaveLength(1)
    expect(m.mounts[0].mount).toBe('/')
  })

  it('размер корня 20 ГБ (килобайты, не блоки по 512)', () => {
    expect(m.mounts[0].totalGb).toBe(20)
  })

  it('аптайм из kern.boottime', () => {
    expect(m.uptime).toBe(86400)
  })

  it('температура', () => {
    expect(m.tempCpu).toBe(45)
  })

  it('топ процессов', () => {
    expect(m.top).toHaveLength(2)
    expect(m.top[0].cmd).toBe('nginx')
  })
})

// ── macOS ──────────────────────────────────────────────────────────────────────────────────────
// Apple Silicon: страница 16384 байт. Два замера top — валиден только второй.
const DARWIN_OUT = `@@N1
Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
en0   1500  <Link#4>      aa:bb:cc:dd:ee:ff  5000      0    5000000     4000     0    2000000     0
en0   1500  192.168.1     192.168.1.5        2500      -    2000000     2000     -    1000000     -
lo0   16384 <Link#1>                          100      0      50000      100     0      50000     0
@@N2
Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
en0   1500  <Link#4>      aa:bb:cc:dd:ee:ff  5100      0    5140000     4100     0    2070000     0
en0   1500  192.168.1     192.168.1.5        2600      -    2100000     2100     -    1050000     -
lo0   16384 <Link#1>                          100      0      50000      100     0      50000     0
@@CPU
CPU usage: 90.00% user, 5.00% sys, 5.00% idle
CPU usage: 12.50% user, 7.50% sys, 80.00% idle
@@MEM
17179869184
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               196608.
Pages active:                             400000.
Pages inactive:                            65536.
Pages speculative:                             0.
@@SWAP
total = 2048,00M  used = 512,00M  free = 1536,00M  (encrypted)
@@LOAD
{ 1.50 1.20 1.10 }
@@UP
{ sec = 1750000000, usec = 0 } Fri Jun 15 12:00:00 2026
1750003600
@@MOUNTS
Filesystem   1024-blocks     Used     Avail Capacity  Mounted on
/dev/disk3s1s1 488245288 20971520 400000000     5%    /
map auto_home          0        0         0   100%    /System/Volumes/Data/home
devfs                197      197         0   100%    /dev
@@TOP
%CPU %MEM COMM
25.0  8.0 WindowServer
 3.5  2.0 Finder
@@END`

describe('parseDarwin', () => {
  const m = parseDarwin(DARWIN_OUT)

  it('CPU берётся из второго замера top, не из первого', () => {
    // Берём ВТОРУЮ строку: 100 - 80 = 20
    expect(m.cpu).toBe(20)
  })

  it('загрузка системы', () => {
    expect(m.load[0]).toBe(1.5)
  })

  it('размер страницы прочитан из заголовка (16К, Apple Silicon)', () => {
    // свободно (196608+65536+0) × 16384 = 4 ГБ ⇒ занято 12 ГБ
    expect(m.ramTotal).toBe(16)
    expect(m.ramUsed).toBe(12)
  })

  it('подкачка с запятой как разделителем', () => {
    expect(m.swapTotal).toBe(2)
    expect(m.swapUsed).toBe(0.5)
  })

  it('сеть без задваивания', () => {
    expect(m.netRx).toBe(200000)
    expect(m.netTx).toBe(100000)
  })

  it('корень занят на 5%, map/devfs отброшены', () => {
    expect(m.disk).toBe(5)
    expect(m.mounts).toHaveLength(1)
  })

  it('аптайм', () => {
    expect(m.uptime).toBe(3600)
  })

  it('ядра пусты — честно, а не выдуманы', () => {
    expect(m.cores).toHaveLength(0)
  })

  it('топ процессов', () => {
    expect(m.top[0]?.cmd).toBe('WindowServer')
  })
})
