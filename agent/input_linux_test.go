//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// Инъекцию ввода нельзя проверить «на глаз»: события уходят в ядро, и ошибка в структуре
// или в ioctl проявится как молчаливое ничего. Поэтому round-trip: создаём виртуальное
// устройство, находим его узел в /dev/input и читаем оттуда то, что сами же отправили.
func TestUinputRoundTrip(t *testing.T) {
	inj, err := newInjector()
	if err != nil {
		t.Skipf("нет доступа к /dev/uinput: %v", err)
	}
	defer inj.Close()

	// Ядру нужен момент, чтобы создать узел устройства.
	var node string
	for i := 0; i < 50 && node == ""; i++ {
		node = findEventNode("Argus Virtual Input")
		if node == "" {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if node == "" {
		t.Fatal("виртуальное устройство не появилось в /dev/input — uinput не создал узел")
	}
	t.Logf("виртуальное устройство: %s", node)

	f, err := os.OpenFile(node, os.O_RDONLY, 0)
	if err != nil {
		t.Skipf("нет прав на чтение %s: %v", node, err)
	}
	defer f.Close()

	// Отправляем движение в заведомо известную точку.
	go func() {
		time.Sleep(150 * time.Millisecond)
		inj.Mouse(0.25, 0.75, 0)
	}()

	deadline := time.Now().Add(3 * time.Second)
	var gotX, gotY int32
	var haveX, haveY bool
	buf := make([]byte, int(unsafe.Sizeof(inputEvent{}))*16)
	for time.Now().Before(deadline) && (!haveX || !haveY) {
		f.SetReadDeadline(deadline)
		n, err := f.Read(buf)
		if err != nil {
			break
		}
		sz := int(unsafe.Sizeof(inputEvent{}))
		for off := 0; off+sz <= n; off += sz {
			e := *(*inputEvent)(unsafe.Pointer(&buf[off]))
			if e.Type == evAbs && e.Code == absX {
				gotX, haveX = e.Value, true
			}
			if e.Type == evAbs && e.Code == absY {
				gotY, haveY = e.Value, true
			}
		}
	}
	if !haveX || !haveY {
		t.Fatal("события ABS_X/ABS_Y не дошли — инъекция не работает")
	}
	mx := float64(absMax) // переменная, а не константа: иначе Go не даст отбросить дробную часть
	wantX, wantY := int32(0.25*mx), int32(0.75*mx)
	if abs32(gotX-wantX) > 2 || abs32(gotY-wantY) > 2 {
		t.Errorf("координаты приехали искажёнными: получили (%d,%d), ждали (%d,%d)", gotX, gotY, wantX, wantY)
	}
	t.Logf("координаты доехали верно: (%d,%d)", gotX, gotY)
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// Находит /dev/input/eventN по имени устройства (через /sys, без лишних ioctl).
func findEventNode(name string) string {
	entries, err := filepath.Glob("/sys/class/input/event*/device/name")
	if err != nil {
		return ""
	}
	for _, p := range entries {
		b, err := os.ReadFile(p)
		if err != nil || strings.TrimSpace(string(b)) != name {
			continue
		}
		parts := strings.Split(p, "/")
		for _, seg := range parts {
			if strings.HasPrefix(seg, "event") {
				return "/dev/input/" + seg
			}
		}
	}
	return ""
}

var _ = syscall.Getpid
