//go:build darwin

package main

import "errors"

// macOS: инъекция ввода требует CGEvent (Core Graphics) и разрешения Accessibility.
// CGEvent доступен только через cgo, а cgo ломает кросс-компиляцию с Linux одной командой —
// поэтому в этой сборке macOS работает как ПРОСМОТР БЕЗ УПРАВЛЕНИЯ, и мы говорим об этом прямо,
// а не делаем вид, что клики уходят в никуда по случайности.
func newInjector() (Injector, error) {
	return &noopInjector{reason: "управление на macOS требует сборки с cgo и разрешения Accessibility"},
		errors.New("управление недоступно: нужна сборка с cgo (CGEvent) + разрешение Accessibility")
}
