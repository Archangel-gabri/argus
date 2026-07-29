//go:build linux

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// Ввод на Linux — через /dev/uinput: ядро создаёт виртуальные мышь и клавиатуру, и события
// доходят до ЛЮБОГО композитора, включая Wayland (X11-инъекция там не работает вовсе).
// Нужны права на /dev/uinput: группа input + udev-правило, это делает провижининг Argus.

const (
	uiSetEvBit   = 0x40045564 // UI_SET_EVBIT
	uiSetKeyBit  = 0x40045565 // UI_SET_KEYBIT
	uiSetRelBit  = 0x40045566 // UI_SET_RELBIT
	uiSetAbsBit  = 0x40045567 // UI_SET_ABSBIT
	uiDevCreate  = 0x5501     // UI_DEV_CREATE
	uiDevDestroy = 0x5502     // UI_DEV_DESTROY

	evSyn = 0x00
	evKey = 0x01
	evRel = 0x02
	evAbs = 0x03

	relWheel = 0x08
	absX     = 0x00
	absY     = 0x01

	btnLeft   = 0x110
	btnRight  = 0x111
	btnMiddle = 0x112

	absMax = 32767
)

type inputEvent struct {
	Sec, Usec int64
	Type      uint16
	Code      uint16
	Value     int32
}

type uinputUserDev struct {
	Name      [80]byte
	ID        struct{ Bustype, Vendor, Product, Version uint16 }
	FFEffects uint32
	Absmax    [64]int32
	Absmin    [64]int32
	Absfuzz   [64]int32
	Absflat   [64]int32
}

type linuxInjector struct {
	f    *os.File
	prev int
}

func ioctl(fd, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); e != 0 {
		return e
	}
	return nil
}

func newInjector() (Injector, error) {
	f, err := os.OpenFile("/dev/uinput", os.O_WRONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("нет доступа к /dev/uinput (%v). Нужны группа input и udev-правило — это ставит провижининг Argus", err)
	}
	fd := f.Fd()
	for _, ev := range []uintptr{evKey, evRel, evAbs, evSyn} {
		if err := ioctl(fd, uiSetEvBit, ev); err != nil {
			f.Close()
			return nil, err
		}
	}
	for _, b := range []uintptr{btnLeft, btnRight, btnMiddle} {
		if err := ioctl(fd, uiSetKeyBit, b); err != nil {
			f.Close()
			return nil, err
		}
	}
	// Все клавиши, которые умеем слать.
	for _, kc := range linuxKey {
		if err := ioctl(fd, uiSetKeyBit, uintptr(kc)); err != nil {
			f.Close()
			return nil, err
		}
	}
	if err := ioctl(fd, uiSetRelBit, relWheel); err != nil {
		f.Close()
		return nil, err
	}
	for _, a := range []uintptr{absX, absY} {
		if err := ioctl(fd, uiSetAbsBit, a); err != nil {
			f.Close()
			return nil, err
		}
	}

	var dev uinputUserDev
	copy(dev.Name[:], "Argus Virtual Input")
	dev.ID.Bustype = 0x03 // USB
	dev.ID.Vendor = 0x4152
	dev.ID.Product = 0x4755
	dev.ID.Version = 1
	dev.Absmax[absX] = absMax
	dev.Absmax[absY] = absMax

	buf := (*[unsafe.Sizeof(dev)]byte)(unsafe.Pointer(&dev))[:]
	if _, err := f.Write(buf); err != nil {
		f.Close()
		return nil, err
	}
	if err := ioctl(fd, uiDevCreate, 0); err != nil {
		f.Close()
		return nil, err
	}
	return &linuxInjector{f: f}, nil
}

func (l *linuxInjector) emit(t, c uint16, v int32) {
	e := inputEvent{Type: t, Code: c, Value: v}
	l.f.Write((*[unsafe.Sizeof(e)]byte)(unsafe.Pointer(&e))[:])
}

func (l *linuxInjector) sync() { l.emit(evSyn, 0, 0) }

func (l *linuxInjector) Close() {
	if l.f != nil {
		ioctl(l.f.Fd(), uiDevDestroy, 0)
		l.f.Close()
	}
}

func (l *linuxInjector) Mouse(x, y float64, buttons int) {
	clamp := func(v float64) int32 {
		if v < 0 {
			v = 0
		}
		if v > 1 {
			v = 1
		}
		return int32(v * absMax)
	}
	l.emit(evAbs, absX, clamp(x))
	l.emit(evAbs, absY, clamp(y))
	changed := l.prev ^ buttons
	for _, b := range []struct {
		mask int
		code uint16
	}{{BtnLeft, btnLeft}, {BtnRight, btnRight}, {BtnMiddle, btnMiddle}} {
		if changed&b.mask == 0 {
			continue
		}
		v := int32(0)
		if buttons&b.mask != 0 {
			v = 1
		}
		l.emit(evKey, b.code, v)
	}
	l.prev = buttons
	l.sync()
}

func (l *linuxInjector) Wheel(delta int) {
	l.emit(evRel, relWheel, int32(delta))
	l.sync()
}

func (l *linuxInjector) Key(code string, down bool) {
	kc, ok := linuxKey[code]
	if !ok {
		return
	}
	v := int32(0)
	if down {
		v = 1
	}
	l.emit(evKey, kc, v)
	l.sync()
}

// DOM KeyboardEvent.code → коды ядра (include/uapi/linux/input-event-codes.h).
var linuxKey = map[string]uint16{
	"Escape": 1, "Digit1": 2, "Digit2": 3, "Digit3": 4, "Digit4": 5, "Digit5": 6, "Digit6": 7,
	"Digit7": 8, "Digit8": 9, "Digit9": 10, "Digit0": 11, "Minus": 12, "Equal": 13, "Backspace": 14,
	"Tab": 15, "KeyQ": 16, "KeyW": 17, "KeyE": 18, "KeyR": 19, "KeyT": 20, "KeyY": 21, "KeyU": 22,
	"KeyI": 23, "KeyO": 24, "KeyP": 25, "BracketLeft": 26, "BracketRight": 27, "Enter": 28,
	"ControlLeft": 29, "KeyA": 30, "KeyS": 31, "KeyD": 32, "KeyF": 33, "KeyG": 34, "KeyH": 35,
	"KeyJ": 36, "KeyK": 37, "KeyL": 38, "Semicolon": 39, "Quote": 40, "Backquote": 41,
	"ShiftLeft": 42, "Backslash": 43, "KeyZ": 44, "KeyX": 45, "KeyC": 46, "KeyV": 47, "KeyB": 48,
	"KeyN": 49, "KeyM": 50, "Comma": 51, "Period": 52, "Slash": 53, "ShiftRight": 54,
	"AltLeft": 56, "Space": 57, "CapsLock": 58,
	"F1": 59, "F2": 60, "F3": 61, "F4": 62, "F5": 63, "F6": 64, "F7": 65, "F8": 66, "F9": 67,
	"F10": 68, "NumLock": 69, "ScrollLock": 70, "F11": 87, "F12": 88,
	"ControlRight": 97, "AltRight": 100, "Home": 102, "ArrowUp": 103, "PageUp": 104,
	"ArrowLeft": 105, "ArrowRight": 106, "End": 107, "ArrowDown": 108, "PageDown": 109,
	"Insert": 110, "Delete": 111, "MetaLeft": 125, "MetaRight": 126, "ContextMenu": 127,
	"PrintScreen": 99, "Pause": 119,
}
