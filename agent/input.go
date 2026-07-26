package main

// Injector — инъекция ввода в живую сессию ОС.
//
// Координаты нормализованные (0..1) намеренно: агент знает реальное разрешение, клиент — нет,
// и при любом масштабировании картинки прицел остаётся верным.
type Injector interface {
	Mouse(x, y float64, buttons int)
	Wheel(delta int)
	Key(code string, down bool)
	Close()
}

// noopInjector — просмотр без управления. Используется там, где инъекция ещё не реализована
// (macOS требует cgo и разрешения Accessibility) или недоступна по правам.
type noopInjector struct{ reason string }

func (n *noopInjector) Mouse(float64, float64, int) {}
func (n *noopInjector) Wheel(int)                   {}
func (n *noopInjector) Key(string, bool)            {}
func (n *noopInjector) Close()                      {}
