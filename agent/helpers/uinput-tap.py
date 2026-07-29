#!/usr/bin/env python3
"""Точный тычок в заданную точку экрана через /dev/uinput.

Почему не обычная мышь: относительные перемещения композитор пропускает через УСКОРЕНИЕ,
поэтому «сместить на 1541 точку» не означает «оказаться в точке 1541» — указатель уезжает
куда-то ещё. Абсолютное устройство (как сенсорный экран) ускорению не подвергается: координата
означает ровно то, что означает.

Использование: utap.py X Y [X Y ...]   ·   utap.py --key enter|space|tab
"""
import fcntl
import os
import struct
import sys
import time

EV_SYN, EV_KEY, EV_ABS = 0x00, 0x01, 0x03
ABS_X, ABS_Y = 0x00, 0x01
BTN_TOUCH, BTN_LEFT = 0x14a, 0x110
KEYS = {'enter': 28, 'space': 57, 'tab': 15, 'esc': 1}
SYN_REPORT = 0
INPUT_PROP_DIRECT = 0x01
UI_SET_EVBIT, UI_SET_KEYBIT = 0x40045564, 0x40045565
UI_SET_ABSBIT, UI_SET_PROPBIT = 0x40045567, 0x4004556e
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502

W, H = 3440, 1440

fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
for ev in (EV_KEY, EV_ABS, EV_SYN):
    fcntl.ioctl(fd, UI_SET_EVBIT, ev)
for k in (BTN_TOUCH, BTN_LEFT, *KEYS.values()):
    fcntl.ioctl(fd, UI_SET_KEYBIT, k)
for a in (ABS_X, ABS_Y):
    fcntl.ioctl(fd, UI_SET_ABSBIT, a)
try:
    fcntl.ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_DIRECT)
except OSError:
    pass  # ядро без поддержки свойств — устройство всё равно будет абсолютным

# uinput_user_dev: имя + id + ff_effects_max + absmax/absmin/absfuzz/absflat по 64 значения
absmax = [0] * 64
absmin = [0] * 64
absmax[ABS_X], absmax[ABS_Y] = W - 1, H - 1
dev = (
    b'argus-remote-touch'.ljust(80, b'\0')
    + struct.pack('HHHH', 3, 0x2222, 0x3333, 1)
    + struct.pack('i', 0)
    + struct.pack('64i', *absmax)
    + struct.pack('64i', *absmin)
    + struct.pack('64i', *[0] * 64)
    + struct.pack('64i', *[0] * 64)
)
os.write(fd, dev)
fcntl.ioctl(fd, UI_DEV_CREATE)
time.sleep(1.2)


def emit(t, c, v):
    os.write(fd, struct.pack('llHHi', 0, 0, t, c, v))


def sync():
    emit(EV_SYN, SYN_REPORT, 0)


def tap(x, y):
    emit(EV_ABS, ABS_X, x)
    emit(EV_ABS, ABS_Y, y)
    sync()
    time.sleep(0.25)
    emit(EV_KEY, BTN_TOUCH, 1)
    emit(EV_KEY, BTN_LEFT, 1)
    emit(EV_ABS, ABS_X, x)
    emit(EV_ABS, ABS_Y, y)
    sync()
    time.sleep(0.09)
    emit(EV_KEY, BTN_TOUCH, 0)
    emit(EV_KEY, BTN_LEFT, 0)
    sync()
    time.sleep(0.3)


try:
    if sys.argv[1] == '--key':
        for name in sys.argv[2:]:
            emit(EV_KEY, KEYS[name], 1)
            sync()
            time.sleep(0.06)
            emit(EV_KEY, KEYS[name], 0)
            sync()
            time.sleep(0.25)
            print(f'нажал {name}')
    else:
        a = [int(v) for v in sys.argv[1:]]
        for i in range(0, len(a) - 1, 2):
            tap(a[i], a[i + 1])
            print(f'тык в ({a[i]}, {a[i + 1]})')
finally:
    time.sleep(0.3)
    fcntl.ioctl(fd, UI_DEV_DESTROY)
    os.close(fd)
