#!/usr/bin/env python3
"""Сеанс портала и конвейер захвата в ОДНОМ процессе, с управляющим каналом.

Зачем так, а не как раньше. Прежде сеанс держал этот скрипт, а кодировал отдельный
`gst-launch-1.0`. Пока качество не меняется, разницы нет — но подстроиться под канал в такой
схеме нельзя: `gst-launch` управлять нечем, сигналом свойство не поменяешь, а переоткрывать
сеанс портала ради смены битрейта значит рвать картинку на каждой ступени. Теперь конвейер
живёт здесь, ссылка на элемент кодировщика сохраняется, и битрейт меняется на ходу —
у nvh264enc свойство помечено «changeable in PLAYING», и кодировщик делает мягкую
перенастройку на следующем кадре.

Каналы намеренно разведены по разным дескрипторам:
  fd 0 (stdin)  — команды: по одной JSON-строке;
  fd 1 (stdout) — ДВОИЧНЫЙ поток H.264 Annex-B, и ничего кроме него;
  fd 2 (stderr) — журнал и события: по одной JSON-строке.
Смешать журнал со stdout нельзя — текст попал бы прямо в видеопоток.

Команды:
  {"cmd":"set-bitrate","kbps":8000}     — битрейт кодировщика, на ходу
  {"cmd":"set-fps","fps":30}            — целевая частота (0 = не ограничивать)
  {"cmd":"keyframe"}                    — выдать ключевой кадр немедленно
  {"cmd":"stop"}                        — закончить

События:
  {"ev":"stream","node":58,"width":3440,"height":1440}
  {"ev":"ready","encoder":"nvh264enc"}
  {"ev":"applied","bitrate":8000,"fps":30}
  {"ev":"error","error":"…"}
"""
import json
import os
import sys
import threading
import time

import gi

gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst  # noqa: E402

TOKEN_FILE = os.path.expanduser('~/.argus/screencast-token')
BUS_NAME = 'org.freedesktop.portal.Desktop'
OBJ = '/org/freedesktop/portal/desktop'
IFACE = 'org.freedesktop.portal.ScreenCast'

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
sender = bus.get_unique_name()[1:].replace('.', '_')
counter = [0]


def emit(**kw):
    """Событие в fd 2. Строкой JSON, чтобы разбор на стороне Go был однозначным."""
    sys.stderr.write(json.dumps(kw, ensure_ascii=False) + '\n')
    sys.stderr.flush()


def token():
    counter[0] += 1
    return f'argus{os.getpid()}_{counter[0]}'


def call(method, params, loop):
    """Вызвать метод портала и ДОЖДАТЬСЯ ответа.

    Портал отвечает не возвратом метода, а сигналом Response на объекте запроса. Подписываться
    надо ДО вызова: иначе быстрый ответ приходит раньше подписки и ждать его можно вечно.
    """
    tok = token()
    path = f'/org/freedesktop/portal/desktop/request/{sender}/{tok}'
    result = {}

    def on_response(_c, _s, _p, _i, _sig, parameters, _u=None):
        result['code'] = parameters[0]
        result['data'] = parameters[1]
        loop.quit()

    sub = bus.signal_subscribe(BUS_NAME, 'org.freedesktop.portal.Request', 'Response', path,
                               None, Gio.DBusSignalFlags.NONE, on_response, None)
    opts = dict(params[-1])
    opts['handle_token'] = GLib.Variant('s', tok)
    args = list(params[:-1]) + [opts]
    bus.call_sync(BUS_NAME, OBJ, IFACE, method, GLib.Variant(SIG[method], tuple(args)),
                  None, Gio.DBusCallFlags.NONE, -1, None)
    GLib.timeout_add_seconds(600, lambda: (loop.quit(), False)[1])
    loop.run()
    bus.signal_unsubscribe(sub)
    if 'code' not in result:
        raise RuntimeError(f'{method}: ответа от портала не пришло за 600с')
    if result['code'] != 0:
        raise RuntimeError(f'{method}: отказано (код {result["code"]}) — согласие не дано')
    return result['data']


SIG = {'CreateSession': '(a{sv})', 'SelectSources': '(oa{sv})', 'Start': '(osa{sv})'}


def open_portal():
    """Поднять сеанс трансляции. Возвращает (номер узла, ширина, высота)."""
    loop = GLib.MainLoop()
    data = call('CreateSession', [{'session_handle_token': GLib.Variant('s', token())}], loop)
    session = data['session_handle']

    opts = {
        'types': GLib.Variant('u', 1),        # 1 = монитор целиком
        'multiple': GLib.Variant('b', False),
        'cursor_mode': GLib.Variant('u', 2),  # курсор вшит в картинку
        'persist_mode': GLib.Variant('u', 2)  # разрешение запоминается до отзыва
    }
    saved = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            saved = f.read().strip()
        if saved:
            opts['restore_token'] = GLib.Variant('s', saved)
    call('SelectSources', [session, opts], loop)

    data = call('Start', [session, '', {}], loop)
    streams = data.get('streams') or []
    if not streams:
        raise RuntimeError('портал не отдал ни одного потока')
    node = streams[0][0]
    props = dict(streams[0][1])
    size = props.get('size') or (0, 0)

    new_token = data.get('restore_token')
    if new_token:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, 'w') as f:
            f.write(new_token)
        os.chmod(TOKEN_FILE, 0o600)

    # Размеры приводим к ЧЁТНЫМ: H.264 кодирует макроблоками, нечётная сторона либо
    # отвергается кодировщиком, либо молча обрезается.
    w = int(size[0]) - int(size[0]) % 2 if size and size[0] else 0
    h = int(size[1]) - int(size[1]) % 2 if size and size[1] else 0
    return node, w, h, bool(saved)


def fit_aspect(w, h, max_height):
    """Уменьшить до max_height, СОХРАНИВ пропорции, и вернуть чётные стороны.

    Искажать нельзя: именно принудительные 1920×1080 превращали сверхширокий экран 21:9 в 16:9.
    Ноль в max_height или картинка ниже предела — оставляем как есть.
    """
    if max_height <= 0 or h <= max_height:
        return w - w % 2, h - h % 2
    nw = w * max_height // h
    return nw - nw % 2, max_height - max_height % 2


class Stream:
    """Конвейер и всё, чем в нём можно управлять на ходу."""

    def __init__(self, node, chain, scale=None):
        # Источник и хвост фиксированы, середину (кодировщик) задаёт Go — там живёт каскад,
        # который решает по ФАКТУ пришедших кадров, а не по наличию железа.
        #
        # keepalive-time обязателен: KWin объявляет переменную частоту и отдаёт кадр только при
        # изменениях картинки, а KPipeWire выбрасывает дубликаты. Без него поток на спокойном
        # экране замолкает, и исправный конвейер выглядит сломанным.
        # Масштабирование вставляем ЗДЕСЬ, а не в цепочке от Go: настоящий размер экрана
        # известен только после ответа портала, то есть уже внутри этого процесса.
        scale_seg = ''
        if scale:
            scale_seg = f'! videoscale ! video/x-raw,width={scale[0]},height={scale[1]} '

        desc = (
            f'pipewiresrc name=src path={node} always-copy=true keepalive-time=120 '
            f'! queue name=q leaky=downstream max-size-buffers=3 max-size-bytes=0 max-size-time=0 '
            f'{scale_seg}'
            f'! {chain} '
            f'! h264parse config-interval=-1 '
            f'! video/x-h264,stream-format=byte-stream,alignment=au '
            f'! fdsink fd=1 sync=false'
        )
        self.pipeline = Gst.parse_launch(desc)
        self.enc = self.pipeline.get_by_name('enc')
        self.src = self.pipeline.get_by_name('src')
        # Целевая частота: 0 = отдавать всё, что даёт композитор.
        self.target_fps = 0
        self._next_at = 0.0
        self._lock = threading.Lock()
        self._install_dropper()

    def _install_dropper(self):
        """Ограничение частоты СБРОСОМ кадров, а не элементом videorate.

        videorate придерживает кадр, чтобы посчитать темп по двум соседним, — на этом источнике
        это давало один кадр за десять секунд (проверено трижды, в том числе после включения
        keepalive). Здесь буфер либо пропускается, либо отбрасывается сразу; ничего не ждём.

        Решение принимается по МОНОТОННЫМ ЧАСАМ, а не по метке времени буфера. Первая попытка
        считала по PTS и уронила поток до 0.5 кадра в секунду: шкала меток у этого источника
        не совпала с ожидаемой, и «следующий разрешённый момент» уезжал далеко вперёд. Часы же
        меряют ровно то, что нам нужно, — сколько кадров в секунду реально уходит клиенту.
        """
        pad = self.src.get_static_pad('src')

        def probe(_pad, _info):
            with self._lock:
                fps = self.target_fps
                if fps <= 0:
                    return Gst.PadProbeReturn.OK
                now = time.monotonic()
                if now < self._next_at:
                    return Gst.PadProbeReturn.DROP
                self._next_at = now + 1.0 / fps
            return Gst.PadProbeReturn.OK

        pad.add_probe(Gst.PadProbeType.BUFFER, probe)

    def start(self):
        self.pipeline.set_state(Gst.State.PLAYING)

    def stop(self):
        self.pipeline.set_state(Gst.State.NULL)

    def set_bitrate(self, kbps):
        if self.enc is None or kbps <= 0:
            return
        # Свойство помечено «changeable in PLAYING»: кодировщик увидит изменение в обработке
        # следующего кадра и сделает мягкую перенастройку. Переоткрывать сеанс портала не нужно.
        self.enc.set_property('bitrate', int(kbps))

    def set_fps(self, fps):
        with self._lock:
            self.target_fps = max(0, int(fps))
            self._next_at = 0.0

    def keyframe(self):
        """Принудительный ключевой кадр — восстановление после потери.

        gop-size на ходу НЕ трогаем: в GStreamer это свойство уровня инициализации и вызовет
        полную перенастройку кодировщика.
        """
        if self.enc is None:
            return
        pad = self.enc.get_static_pad('sink')
        if pad is None:
            return
        pad.send_event(Gst.Event.new_custom(
            Gst.EventType.CUSTOM_DOWNSTREAM,
            Gst.Structure.new_from_string('GstForceKeyUnit, all-headers=(boolean)true')))


def commands(stream, loop):
    """Читает команды из stdin построчно. Отдельный поток: разбор не должен мешать конвейеру."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            emit(ev='error', error=f'команда не разобрана: {line[:80]}')
            continue
        cmd = msg.get('cmd')
        if cmd == 'set-bitrate':
            stream.set_bitrate(msg.get('kbps', 0))
            emit(ev='applied', bitrate=msg.get('kbps', 0), fps=stream.target_fps)
        elif cmd == 'set-fps':
            stream.set_fps(msg.get('fps', 0))
            emit(ev='applied', bitrate=None, fps=stream.target_fps)
        elif cmd == 'keyframe':
            stream.keyframe()
            emit(ev='applied', keyframe=True)
        elif cmd == 'stop':
            break
        else:
            emit(ev='error', error=f'неизвестная команда: {cmd}')
    loop.quit()


def main():
    if len(sys.argv) < 2:
        emit(ev='error', error='не передана цепочка кодировщика')
        return 1
    chain = sys.argv[1]
    # Необязательный предел по высоте — для программного кодировщика, которому родное
    # разрешение не по силам. Ноль или отсутствие = отдавать как есть.
    max_height = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    Gst.init(None)
    try:
        node, w, h, reused = open_portal()
    except Exception as e:  # noqa: BLE001 — причину надо показать как есть
        emit(ev='error', error=str(e))
        return 1

    scale = None
    out_w, out_h = w, h
    if w and h:
        out_w, out_h = fit_aspect(w, h, max_height)
        if (out_w, out_h) != (w, h):
            scale = (out_w, out_h)
    # Размер сообщаем ИТОГОВЫЙ — тот, что реально поедет клиенту.
    emit(ev='stream', node=node, width=out_w, height=out_h, source_width=w, source_height=h,
         reused=reused)

    try:
        stream = Stream(node, chain, scale)
    except Exception as e:  # noqa: BLE001
        emit(ev='error', error=f'конвейер не собрался: {e}')
        return 1

    loop = GLib.MainLoop()

    def on_message(_bus, message):
        if message.type == Gst.MessageType.ERROR:
            err, dbg = message.parse_error()
            emit(ev='error', error=str(err), detail=dbg or '')
            loop.quit()
        elif message.type == Gst.MessageType.EOS:
            emit(ev='error', error='поток закончился')
            loop.quit()
        return True

    b = stream.pipeline.get_bus()
    b.add_signal_watch()
    b.connect('message', on_message)

    stream.start()
    emit(ev='ready', encoder=chain.split()[0])

    threading.Thread(target=commands, args=(stream, loop), daemon=True).start()
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    stream.stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
