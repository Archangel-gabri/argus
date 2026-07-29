//go:build linux

package main

import "testing"

// Разбор размера экрана из ответа портала. Образцы — ровно в том виде, в каком их печатает
// клиент портала (кортеж Python), включая случаи, когда портал размер не сообщил.
func TestParseSize(t *testing.T) {
	cases := []struct {
		in     string
		w, h   int
		reason string
	}{
		{"(3440, 1440)", 3440, 1440, "живой стенд: сверхширокий монитор"},
		{"(1920, 1080)", 1920, 1080, "обычный монитор"},
		{"(2560,1600)", 2560, 1600, "без пробела после запятой"},
		{"(1365, 767)", 1364, 766, "нечётные стороны приводятся к чётным: H.264 кодирует макроблоками"},
		{"None", 0, 0, "портал размера не дал — не выдумываем"},
		{"()", 0, 0, "пустой кортеж"},
		{"(0, 0)", 0, 0, "нули — это не размер"},
		{"(-1920, 1080)", 0, 0, "отрицательная сторона"},
		{"(1920, 1080, 60)", 0, 0, "три элемента — формат не тот, что мы понимаем"},
	}
	for _, c := range cases {
		w, h := parseSize(c.in)
		if w != c.w || h != c.h {
			t.Errorf("parseSize(%q) = %d×%d, ожидалось %d×%d (%s)", c.in, w, h, c.w, c.h, c.reason)
		}
	}
}

// Уменьшение под возможности программного кодировщика. Главное требование — НЕ ИСКАЖАТЬ:
// именно из-за принудительных 1920×1080 сверхширокий экран показывался сплющенным.
func TestFitAspect(t *testing.T) {
	cases := []struct {
		w, h, max  string
		inW, inH   int
		maxH       int
		outW, outH int
		reason     string
	}{
		{inW: 3440, inH: 1440, maxH: 1080, outW: 2580, outH: 1080,
			reason: "21:9 остаётся 21:9 (3440/1440 = 2580/1080)"},
		{inW: 1920, inH: 1080, maxH: 1080, outW: 1920, outH: 1080,
			reason: "ровно на границе — не трогаем"},
		{inW: 1366, inH: 768, maxH: 1080, outW: 1366, outH: 768,
			reason: "ниже предела — оставляем как есть"},
		{inW: 3840, inH: 2160, maxH: 1080, outW: 1920, outH: 1080,
			reason: "4K уменьшается ровно вдвое"},
		{inW: 2560, inH: 1600, maxH: 1080, outW: 1728, outH: 1080,
			reason: "16:10 (1728/1080 = 1.6) — пропорция сохранена, сторона чётная"},
		{inW: 3440, inH: 1440, maxH: 0, outW: 3440, outH: 1440,
			reason: "предела нет — родное разрешение"},
		{inW: 1365, inH: 767, maxH: 0, outW: 1364, outH: 766,
			reason: "без предела всё равно приводим к чётным"},
	}
	for _, c := range cases {
		w, h := fitAspect(c.inW, c.inH, c.maxH)
		if w != c.outW || h != c.outH {
			t.Errorf("fitAspect(%d, %d, %d) = %d×%d, ожидалось %d×%d (%s)",
				c.inW, c.inH, c.maxH, w, h, c.outW, c.outH, c.reason)
		}
		if w%2 != 0 || h%2 != 0 {
			t.Errorf("fitAspect(%d, %d, %d) вернул нечётную сторону %d×%d", c.inW, c.inH, c.maxH, w, h)
		}
	}
}

// Конвейер собирается из звеньев: проверяем, что масштабирование появляется ТОЛЬКО когда
// размер действительно меняется, и что родное разрешение обходится без videoscale вовсе.
func TestGstArgsScaleOnlyWhenNeeded(t *testing.T) {
	st := portalStream{node: "58", width: 3440, height: 1440}
	enc := waylandEncoders[0] // nvenc, родное разрешение

	native := gstArgs(enc, st, 3440, 1440, 60)
	if contains(native, "videoscale") {
		t.Error("родное разрешение не должно тянуть videoscale — это лишняя работа на процессоре")
	}
	if !contains(native, "nvh264enc") {
		t.Error("аппаратный вариант должен звать nvh264enc")
	}

	scaled := gstArgs(waylandEncoders[len(waylandEncoders)-1], st, 2580, 1080, 30)
	if !contains(scaled, "videoscale") {
		t.Error("уменьшение требует videoscale")
	}
	if !contains(scaled, "video/x-raw,width=2580,height=1080") {
		t.Errorf("в аргументах нет требуемого размера: %v", scaled)
	}
	// videorate в этом конвейере запрещён по результатам ТРЁХ живых проверок: он придерживает
	// кадр, чтобы посчитать темп по двум соседним, и на источнике, который отдаёт кадры по
	// изменениям картинки, это даёт 1 кадр за 10 секунд. Третья проверка была уже ПОСЛЕ
	// включения keepalive-time, когда поток стал непрерывным, — результат не изменился.
	// Этот тест стоит здесь, чтобы попытка №4 упала на проверках, а не на живом стенде.
	if contains(scaled, "videorate") || contains(native, "videorate") {
		t.Error("videorate вернулся в конвейер — проверено трижды, он даёт 1 кадр за 10с")
	}

	// keepalive-time обязателен: без него KWin (переменная частота + отбрасывание дубликатов)
	// замолкает на спокойном экране, и исправный конвейер выглядит сломанным.
	if !contains(native, "keepalive-time=120") {
		t.Error("у pipewiresrc пропал keepalive-time — поток замолчит на неподвижном экране")
	}

	// SPS/PPS обязаны идти перед КАЖДЫМ ключевым кадром: WebCodecs в режиме annexb требует
	// заголовки внутри ключевого чанка, иначе подключившийся позже клиент не настроит декодер.
	if !contains(native, "config-interval=-1") {
		t.Error("h264parse без config-interval=-1 — клиент, подключившийся между ключевыми, ослепнет")
	}
	if !contains(native, "repeat-sequence-header=true") {
		t.Error("у nvh264enc выключен repeat-sequence-header (по умолчанию false)")
	}

	// Аппаратный путь не должен тащить преобразование формата на процессоре: NVENC принимает
	// BGRx напрямую и делает преобразование одним CUDA-ядром внутри себя.
	if contains(native, "videoconvert") || contains(native, "cudaupload") {
		t.Error("в основном аппаратном пути появилось преобразование формата — оно втрое дороже")
	}
}

func contains(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}
