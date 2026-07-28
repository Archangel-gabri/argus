# Совместимость по операционным системам

Что из возможностей Argus реально работает на какой ОС. Составлено по документации и man-страницам
(ссылки внизу), а не по догадкам. Обновлять при добавлении новых команд.

## Сводка

| Возможность | Linux (Ubuntu/Debian/Arch/Fedora/Alpine) | Windows | macOS | FreeBSD | OpenWrt / Synology |
|---|---|---|---|---|---|
| Определение живой ОС (`echo`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Терминал | ✅ | ✅ | ✅ | ✅ | ✅ |
| Файлы (SFTP) | ✅ | ✅ | ✅ | ✅ | ⚠️ OpenWrt часто без sftp-server |
| Метрики | ✅ | ✅ | ❌ нет `/proc` | ❌ нет `/proc` | ⚠️ busybox, часть полей пуста |
| Порты | ✅ `ss` | ✅ | ⚠️ команда есть, разбора нет | ⚠️ команда есть, разбора нет | ⚠️ зависит от сборки |
| Питание | ✅ | ✅ | ✅ | ✅ | ⚠️ обычно только reboot |
| Экран | через агент | ✅ RDP + агент | агент, просмотр без управления | ❌ | ❌ |
| Инвентарь железа | ✅ | ✅ | ❌ | ❌ | ❌ |

## Что уже исправлено под не-Linux

- **`df`**: убран флаг `-x` (его нет на BSD и macOS) и добавлен явный `-k`. Причина серьёзная:
  на BSD и macOS `-P` означает блоки по **512 байт**, а не по 1024 — без `-k` все размеры дисков
  молча оказывались вдвое меньше настоящих. Служебные файловые системы теперь отсеиваются при
  разборе, а не флагом.
- **`ps`**: `--sort=-pcpu` есть только у GNU. На BSD и macOS сортировка по CPU — это `-r`,
  а `-e` там значит совсем другое (на FreeBSD — «показать окружение»). Добавлен переносимый запасной
  вариант `ps -axco pcpu,pmem,comm -r`.
- **Питание**: `systemctl` есть только в Linux. Цепочка расширена до
  `systemctl → shutdown (BSD/macOS) → reboot/poweroff`. Отдельно учтено: выключение на FreeBSD —
  `shutdown -p now` (`-h` только останавливает, питание остаётся); сон на macOS — `pmset sleepnow`
  (работает без sudo), на FreeBSD — `zzz` либо `acpiconf -s3`.
- **Порты**: цепочка `ss → sockstat (FreeBSD) → lsof (macOS)`. Формат вывода у них разный, разбор
  пока написан только для `ss` и Windows — поэтому при непустом ответе в чужом формате возвращается
  честная ошибка, а НЕ пустой список, который выглядел бы как «портов нет».
- **Зонд метрик** больше не выдаёт правдоподобные нули на не-Linux: проверяется код возврата и то,
  что хоть что-то разобралось.

## Известные ограничения

**Метрики на macOS и FreeBSD не работают.** Причина принципиальная: там **нет `/proc`**, на котором
построен весь зонд (`/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `/proc/diskstats`, `/proc/loadavg`,
`/proc/uptime`). На FreeBSD procfs не монтируется по умолчанию и объявлен устаревшим; на macOS его
нет вовсе. Нужен отдельный зонд на `sysctl` / `vm_stat` / `netstat -ibn` / `iostat`.
Отдельная сложность: **загрузку по ядрам на macOS из командной строки получить нечем** — нужен
системный вызов, а он требует cgo, что ломает кросс-компиляцию агента одной командой.

**Оболочка входа.** SSH выполняет команду через оболочку учётной записи. Если это `csh`/`tcsh`
(встречается на FreeBSD после обновления с 13 и на устройствах вроде pfSense), ломаются `2>&1`
и `$(...)` — синтаксис, которым пользуется зонд. Надёжный обход — передавать скрипт в `/bin/sh -s`
через стандартный ввод, чтобы кавычки не переразбирались чужой оболочкой.

**macOS и PATH.** Неинтерактивный SSH читает только `~/.zshenv`, а Homebrew прописывает PATH в
`~/.zprofile`. Поэтому `/opt/homebrew/bin` в сеансе отсутствует, и `ffmpeg` «не найден», хотя он
установлен. Наш агент это уже обходит: сначала ищет ffmpeg рядом с собой, и только потом в PATH.

**Сетевые счётчики.** У `netstat` на BSD и macOS каждый интерфейс печатает строку `<Link#N>` плюс по
строке на каждый адрес — если суммировать всё подряд, трафик задваивается.

## Источники

- FreeBSD 14: [procfs](https://man.freebsd.org/cgi/man.cgi?query=procfs&sektion=5) ·
  [df](https://man.freebsd.org/cgi/man.cgi?query=df&sektion=1) ·
  [ps](https://man.freebsd.org/cgi/man.cgi?query=ps&sektion=1) ·
  [sockstat](https://man.freebsd.org/cgi/man.cgi?query=sockstat&sektion=1) ·
  [shutdown](https://man.freebsd.org/cgi/man.cgi?query=shutdown&sektion=8) ·
  [zzz](https://man.freebsd.org/cgi/man.cgi?query=zzz&sektion=8) ·
  [релиз-ноты 14.0](https://www.freebsd.org/releases/14.0R/relnotes/) (оболочка root — `sh`)
- macOS: [df](https://keith.github.io/xcode-man-pages/df.1.html) ·
  [ps](https://keith.github.io/xcode-man-pages/ps.1.html) ·
  [vm_stat](https://keith.github.io/xcode-man-pages/vm_stat.1.html) ·
  [pmset](https://keith.github.io/xcode-man-pages/pmset.1.html) ·
  [нет procfs](http://www.osxbook.com/book/bonus/chapter11/procfs/) ·
  [zsh с Catalina](https://support.apple.com/en-au/HT208050) ·
  [PATH Homebrew по SSH](https://github.com/orgs/Homebrew/discussions/1307)
- GNU: [df и POSIXLY_CORRECT](https://www.gnu.org/software/coreutils/manual/html_node/df-invocation.html)
