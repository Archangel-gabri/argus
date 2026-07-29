// Протокол между агентом и Argus. Одно WebSocket-соединение несёт и видео, и ввод:
//
//	сервер → клиент: БИНАРНЫЕ кадры (Annex-B H.264) и ТЕКСТОВЫЕ управляющие сообщения (JSON)
//	клиент → сервер: ТЕКСТОВЫЕ сообщения ввода (JSON)
//
// Разделение по типу кадра WebSocket, поэтому парсить заголовки не нужно.
package main

// Version — версия протокола/агента. Argus сверяет её при провижининге и обновляет бинарь,
// если версия на машине отстала.
const Version = "0.1.0"

// ── сервер → клиент ────────────────────────────────────────────────────────────────────────────

// Hello — первое сообщение после успешной авторизации: чем кодируем и что за экран.
type Hello struct {
	Type    string `json:"type"` // "hello"
	Version string `json:"version"`
	OS      string `json:"os"`
	Encoder string `json:"encoder"` // h264_nvenc / h264_vaapi / h264_qsv / h264_amf / libx264
	Source  string `json:"source"`  // чем захватываем (ddagrab / x11grab / lavfi …)
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	// FPS — ОРИЕНТИР, на который настроен кодировщик (по нему считается интервал ключевых
	// кадров), а не обещание. Реальную частоту клиент считает сам по приходящим кадрам: на
	// Wayland источник отдаёт кадр только при изменении картинки, поэтому на спокойном экране
	// частота близка к нулю, а на 100-герцовом мониторе под нагрузкой доходит до ~97.
	FPS int `json:"fps"`
	// Codec в формате WebCodecs (avc1.42E01F и т.п.) — клиент передаёт его в VideoDecoder.
	Codec string `json:"codec"`
}

// Fatal — поток не поднялся или умер: клиенту нужен внятный текст, а не тишина.
type Fatal struct {
	Type   string `json:"type"` // "fatal"
	Error  string `json:"error"`
	Detail string `json:"detail,omitempty"`
}

// ── клиент → сервер ────────────────────────────────────────────────────────────────────────────

// InputMsg — событие ввода. Координаты НОРМАЛИЗОВАННЫЕ (0..1), чтобы клиент не зависел от
// реального разрешения экрана и от масштабирования картинки.
type InputMsg struct {
	Type string `json:"type"` // mouse | wheel | key | ping

	X float64 `json:"x,omitempty"` // 0..1
	Y float64 `json:"y,omitempty"` // 0..1

	// Битовая маска зажатых кнопок: 1 = левая, 2 = правая, 4 = средняя.
	Buttons int `json:"buttons,omitempty"`

	// Колесо: положительное — от себя (вверх).
	Delta int `json:"delta,omitempty"`

	// Клавиша: код в стиле DOM KeyboardEvent.code (KeyA, Enter, ShiftLeft…), down=нажатие.
	Code string `json:"code,omitempty"`
	Down bool   `json:"down,omitempty"`
}

const (
	BtnLeft   = 1
	BtnRight  = 2
	BtnMiddle = 4
)
