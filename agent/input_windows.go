//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// Ввод на Windows — через SendInput (user32). Мышь двигаем в АБСОЛЮТНЫХ координатах
// (0..65535 по виртуальному рабочему столу), поэтому многомониторные конфигурации и
// масштабирование картинки у клиента не сбивают прицел.

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	procSendInput    = user32.NewProc("SendInput")
	procGetSystemMet = user32.NewProc("GetSystemMetrics")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseeventfMove       = 0x0001
	mouseeventfLeftDown   = 0x0002
	mouseeventfLeftUp     = 0x0004
	mouseeventfRightDown  = 0x0008
	mouseeventfRightUp    = 0x0010
	mouseeventfMiddleDown = 0x0020
	mouseeventfMiddleUp   = 0x0040
	mouseeventfWheel      = 0x0800
	mouseeventfAbsolute   = 0x8000
	mouseeventfVirtualDsk = 0x4000

	keyeventfKeyUp   = 0x0002
	keyeventfUnicode = 0x0004
)

type mouseInput struct {
	dx          int32
	dy          int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
	_           [8]byte // выравнивание до размера MOUSEINPUT
}

type input struct {
	inputType uint32
	_         uint32 // padding под 64-битное выравнивание union
	mi        mouseInput
}

func send(in *input) {
	procSendInput.Call(1, uintptr(unsafe.Pointer(in)), unsafe.Sizeof(*in))
}

func sendMouse(flags uint32, dx, dy int32, data uint32) {
	in := input{inputType: inputMouse}
	in.mi = mouseInput{dx: dx, dy: dy, mouseData: data, dwFlags: flags}
	send(&in)
}

func sendKey(vk uint16, up bool) {
	in := input{inputType: inputKeyboard}
	k := keybdInput{wVk: vk}
	if up {
		k.dwFlags = keyeventfKeyUp
	}
	*(*keybdInput)(unsafe.Pointer(&in.mi)) = k
	send(&in)
}

type winInjector struct {
	prevButtons int
	// Что сейчас зажато. Нужно ровно для одного: отпустить при разрыве сеанса.
	held map[uint16]bool
}

func newInjector() (Injector, error) { return &winInjector{held: map[uint16]bool{}}, nil }

// Close отпускает всё, что осталось зажатым.
//
// Разрыв сеанса происходит в произвольный момент — в том числе когда человек держит Alt+Tab
// или тянет окно мышью. Ответного «отпустил» уже не придёт, и машина остаётся с зажатыми
// клавишами и кнопкой: дальше она сама по себе выделяет текст, повторяет символы и открывает
// переключатель окон. Владелец при этом уже не подключён и починить не может.
func (w *winInjector) Close() {
	for vk := range w.held {
		sendKey(vk, true)
	}
	w.held = map[uint16]bool{}
	for _, b := range []struct {
		mask int
		up   uint32
	}{
		{BtnLeft, mouseeventfLeftUp},
		{BtnRight, mouseeventfRightUp},
		{BtnMiddle, mouseeventfMiddleUp},
	} {
		if w.prevButtons&b.mask != 0 {
			sendMouse(b.up, 0, 0, 0)
		}
	}
	w.prevButtons = 0
}

func (w *winInjector) Mouse(x, y float64, buttons int) {
	// Абсолютные координаты по ВИРТУАЛЬНОМУ рабочему столу — иначе на втором мониторе промах.
	abs := func(v float64) int32 {
		if v < 0 {
			v = 0
		}
		if v > 1 {
			v = 1
		}
		return int32(v * 65535)
	}
	sendMouse(mouseeventfMove|mouseeventfAbsolute|mouseeventfVirtualDsk, abs(x), abs(y), 0)

	changed := w.prevButtons ^ buttons
	for _, b := range []struct {
		mask     int
		down, up uint32
	}{
		{BtnLeft, mouseeventfLeftDown, mouseeventfLeftUp},
		{BtnRight, mouseeventfRightDown, mouseeventfRightUp},
		{BtnMiddle, mouseeventfMiddleDown, mouseeventfMiddleUp},
	} {
		if changed&b.mask == 0 {
			continue
		}
		if buttons&b.mask != 0 {
			sendMouse(b.down, 0, 0, 0)
		} else {
			sendMouse(b.up, 0, 0, 0)
		}
	}
	w.prevButtons = buttons
}

func (w *winInjector) Wheel(delta int) {
	sendMouse(mouseeventfWheel, 0, 0, uint32(int32(delta*120)))
}

func (w *winInjector) Key(code string, down bool) {
	vk, ok := winVK[code]
	if !ok {
		return
	}
	if w.held == nil {
		w.held = map[uint16]bool{}
	}
	if down {
		w.held[vk] = true
	} else {
		delete(w.held, vk)
	}
	sendKey(vk, !down)
}

// Соответствие DOM KeyboardEvent.code → виртуальным кодам Windows.
var winVK = map[string]uint16{
	"Escape": 0x1B, "Tab": 0x09, "CapsLock": 0x14, "Space": 0x20, "Enter": 0x0D, "Backspace": 0x08,
	"ShiftLeft": 0xA0, "ShiftRight": 0xA1, "ControlLeft": 0xA2, "ControlRight": 0xA3,
	"AltLeft": 0xA4, "AltRight": 0xA5, "MetaLeft": 0x5B, "MetaRight": 0x5C, "ContextMenu": 0x5D,
	"ArrowUp": 0x26, "ArrowDown": 0x28, "ArrowLeft": 0x25, "ArrowRight": 0x27,
	"Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22, "Insert": 0x2D, "Delete": 0x2E,
	"Minus": 0xBD, "Equal": 0xBB, "BracketLeft": 0xDB, "BracketRight": 0xDD, "Backslash": 0xDC,
	"Semicolon": 0xBA, "Quote": 0xDE, "Backquote": 0xC0, "Comma": 0xBC, "Period": 0xBE, "Slash": 0xBF,
	"NumLock": 0x90, "ScrollLock": 0x91, "PrintScreen": 0x2C, "Pause": 0x13,
}

func init() {
	for i, c := range "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
		winVK["Key"+string(c)] = uint16(0x41 + i)
	}
	for i := 0; i <= 9; i++ {
		winVK["Digit"+string(rune('0'+i))] = uint16(0x30 + i)
		winVK["Numpad"+string(rune('0'+i))] = uint16(0x60 + i)
	}
	for i := 1; i <= 12; i++ {
		name := "F" + itoa(i)
		winVK[name] = uint16(0x6F + i)
	}
}

func itoa(i int) string {
	if i < 10 {
		return string(rune('0' + i))
	}
	return string(rune('0'+i/10)) + string(rune('0'+i%10))
}
