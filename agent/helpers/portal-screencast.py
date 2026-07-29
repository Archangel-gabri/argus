#!/usr/bin/env python3
"""Клиент портала ScreenCast: получает у KDE поток экрана и печатает номер узла PipeWire.

Зачем отдельный клиент: на Wayland ни одна программа не может просто «взять экран» —
композитор отдаёт картинку только через портал, с явного согласия хозяина машины.
Согласие спрашивается ОДИН раз: при persist_mode=2 портал выдаёт токен восстановления,
и дальше сеанс поднимается молча. Токен храним рядом с агентом.

Печатает в stdout: NODE=<id> и TOKEN_SAVED=<путь> либо ERROR=<причина>.
"""
import os
import sys
import json
from gi.repository import Gio, GLib

TOKEN_FILE = os.path.expanduser('~/.argus/screencast-token')
BUS_NAME = 'org.freedesktop.portal.Desktop'
OBJ = '/org/freedesktop/portal/desktop'
IFACE = 'org.freedesktop.portal.ScreenCast'

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
sender = bus.get_unique_name()[1:].replace('.', '_')
loop = GLib.MainLoop()
counter = [0]


def token():
    counter[0] += 1
    return f'argus{os.getpid()}_{counter[0]}'


def call(method, params):
    """Вызвать метод портала и ДОЖДАТЬСЯ ответа.

    Портал отвечает не возвратом метода, а сигналом Response на объекте запроса. Подписываться
    надо ДО вызова: иначе быстрый ответ приходит раньше подписки и ждать его можно вечно.
    """
    tok = token()
    path = f'/org/freedesktop/portal/desktop/request/{sender}/{tok}'
    result = {}

    def on_response(_conn, _sender, _path, _iface, _signal, parameters, _user_data=None):
        result['code'] = parameters[0]
        result['data'] = parameters[1]
        loop.quit()

    sub = bus.signal_subscribe(BUS_NAME, 'org.freedesktop.portal.Request', 'Response', path,
                               None, Gio.DBusSignalFlags.NONE, on_response, None)
    opts = dict(params[-1])
    opts['handle_token'] = GLib.Variant('s', tok)
    args = list(params[:-1]) + [opts]
    bus.call_sync(BUS_NAME, OBJ, IFACE, method, GLib.Variant(sig[method], tuple(args)),
                  None, Gio.DBusCallFlags.NONE, -1, None)
    GLib.timeout_add_seconds(600, lambda: (loop.quit(), False)[1])
    loop.run()
    bus.signal_unsubscribe(sub)
    if 'code' not in result:
        raise RuntimeError(f'{method}: ответа от портала не пришло за 600с')
    if result['code'] != 0:
        raise RuntimeError(f'{method}: отказано (код {result["code"]}) — согласие не дано')
    return result['data']


sig = {
    'CreateSession': '(a{sv})',
    'SelectSources': '(oa{sv})',
    'Start': '(osa{sv})'
}

try:
    ses_tok = token()
    data = call('CreateSession', [{'session_handle_token': GLib.Variant('s', ses_tok)}])
    session = data['session_handle']

    opts = {
        'types': GLib.Variant('u', 1),          # 1 = монитор целиком
        'multiple': GLib.Variant('b', False),
        'cursor_mode': GLib.Variant('u', 2),    # курсор вшит в картинку
        'persist_mode': GLib.Variant('u', 2)    # разрешение запоминается до отзыва
    }
    saved = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            saved = f.read().strip()
        if saved:
            opts['restore_token'] = GLib.Variant('s', saved)
    call('SelectSources', [session, opts])

    data = call('Start', [session, '', {}])
    streams = data.get('streams') or []
    if not streams:
        print('ERROR=портал не отдал ни одного потока')
        sys.exit(1)
    node_id = streams[0][0]
    props = dict(streams[0][1])
    size = props.get('size')

    new_token = data.get('restore_token')
    if new_token:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, 'w') as f:
            f.write(new_token)
        os.chmod(TOKEN_FILE, 0o600)

    # SIZE печатается ПЕРЕД NODE намеренно: читатель на стороне агента ждёт строку NODE= как
    # признак готовности и на ней прекращает чтение. Обратный порядок означал, что размер
    # экрана до агента не доезжал никогда, и картинка приводилась к размеру по умолчанию.
    print(f'SIZE={size}')
    print(f'NODE={node_id}')
    print(f'TOKEN_SAVED={TOKEN_FILE if new_token else "нет (портал не выдал)"}')
    print(f'REUSED={"да" if saved else "нет — спрашивали согласие"}')
    # Сеанс живёт, пока жив этот процесс: закроем — поток закроется.
    if os.environ.get('ARGUS_HOLD') == '1':
        print('HOLDING', flush=True)
        GLib.MainLoop().run()
except Exception as e:  # noqa: BLE001 — любую причину надо показать как есть
    print(f'ERROR={e}')
    sys.exit(1)
