package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Нарезка Annex-B на access unit'ы — самое хрупкое место: WebCodecs принимает только ЦЕЛЫЕ
// кадры, и ошибка здесь даёт «подключено, но чёрный экран» без единого сообщения об ошибке.
// Поэтому проверяем не на глаз, а настоящим декодером: сшиваем выданные кадры обратно и
// смотрим, согласен ли ffmpeg, что это валидный поток и что кадров ровно столько же.
func TestSplitAnnexBProducesDecodableFrames(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg не установлен")
	}
	testSource = true
	bitrate = 4000

	st := NewStreamer(30, 640, 360)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var stream bytes.Buffer
	var aus []AU
	done := make(chan error, 1)
	go func() {
		done <- st.Run(ctx, func(au AU) {
			aus = append(aus, au)
			stream.Write(au.Data)
			if len(aus) >= 30 {
				cancel()
			}
		})
	}()
	<-done

	if len(aus) < 10 {
		t.Fatalf("получено слишком мало кадров: %d", len(aus))
	}
	if !aus[0].IsKey {
		t.Errorf("первый кадр обязан быть ключевым, иначе декодер не стартует")
	}
	for i, au := range aus {
		if len(au.Data) < 5 || !bytes.HasPrefix(au.Data, []byte{0, 0, 0, 1}) {
			t.Fatalf("кадр %d не начинается со стартового кода Annex-B", i)
		}
		if au.IsKey && !hasNAL(au.Data, 5) && !hasNAL(au.Data, 7) {
			t.Errorf("кадр %d помечен ключевым, но в нём нет ни IDR, ни SPS", i)
		}
	}

	// Первый кадр должен нести SPS+PPS — иначе клиент, подключившийся к идущему потоку,
	// не сможет сконфигурировать декодер (ради этого в ffmpeg включён dump_extra).
	if !hasNAL(aus[0].Data, 7) || !hasNAL(aus[0].Data, 8) {
		t.Errorf("в первом кадре нет SPS/PPS — клиент не инициализирует декодер")
	}

	// Проверка настоящим декодером.
	f, err := os.CreateTemp("", "argus-*.h264")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	f.Write(stream.Bytes())
	f.Close()

	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-count_frames", "-show_entries", "stream=nb_read_frames",
		"-of", "default=nokey=1:noprint_wrappers=1", f.Name()).Output()
	if err != nil {
		t.Fatalf("ffprobe не смог прочитать сшитый поток: %v", err)
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	if n < len(aus)-2 || n > len(aus)+2 {
		t.Errorf("декодер насчитал %d кадров, а мы отдали %d — нарезка теряет или склеивает кадры", n, len(aus))
	}
	t.Logf("кадров отдано: %d, декодер подтвердил: %d", len(aus), n)
}

func hasNAL(data []byte, nalType byte) bool {
	for i := 0; i+4 < len(data); i++ {
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 0 && data[i+3] == 1 {
			if data[i+4]&0x1f == nalType {
				return true
			}
		}
	}
	return false
}

// Строка кодека для WebCodecs собирается из НАСТОЯЩЕГО заголовка потока.
//
// Байты SPS ниже сняты с живого стенда (NVENC, монитор 3440×1440): profile_idc=0x42 (Baseline),
// ограничения 0xC0, level_idc=0x3C (уровень 6.0). До этого в приветствии стояло зашитое
// «avc1.42E01F» — тот же профиль, но уровень 3.1, то есть заявка примерно на 1280×720.
// По этой строке клиент настраивает декодер, и аппаратный декодер вправе отказаться, если
// объявленный уровень ниже фактического.
func TestCodecFromSPS(t *testing.T) {
	// Реальный первый кадр: SPS с четырёхбайтовым стартовым кодом.
	live := append([]byte{0x00, 0x00, 0x00, 0x01},
		0x67, 0x42, 0xc0, 0x3c, 0x95, 0x90, 0x03, 0x5c, 0x00, 0x00)
	if got := codecFromSPS(live); got != "avc1.42C03C" {
		t.Errorf("живой поток: получено %q, ожидалось avc1.42C03C", got)
	}

	// Трёхбайтовый стартовый код — тоже допустимый по спецификации.
	short := append([]byte{0x00, 0x00, 0x01},
		0x67, 0x64, 0x00, 0x33, 0xac, 0xd9, 0x40, 0x50)
	if got := codecFromSPS(short); got != "avc1.640033" {
		t.Errorf("трёхбайтовый стартовый код: получено %q, ожидалось avc1.640033 (High 5.1)", got)
	}

	// SPS может идти не первым NAL в кадре: перед ним бывает разделитель access unit (тип 9).
	afterAud := append([]byte{0x00, 0x00, 0x00, 0x01, 0x09, 0x10},
		0x00, 0x00, 0x00, 0x01, 0x67, 0x4d, 0x40, 0x28, 0xff)
	if got := codecFromSPS(afterAud); got != "avc1.4D4028" {
		t.Errorf("SPS после разделителя: получено %q, ожидалось avc1.4D4028", got)
	}

	// Кадр без SPS — пустая строка, а НЕ выдуманное значение: вызывающий сам решит,
	// оставить ли прежнее. Молча подставить правдоподобное здесь было бы хуже всего.
	noSps := []byte{0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x21}
	if got := codecFromSPS(noSps); got != "" {
		t.Errorf("кадр без SPS: получено %q, ожидалась пустая строка", got)
	}

	// Обрезанный SPS (байтов на профиль/уровень не хватает) не должен ни падать, ни угадывать.
	if got := codecFromSPS([]byte{0x00, 0x00, 0x00, 0x01, 0x67, 0x42}); got != "" {
		t.Errorf("обрезанный SPS: получено %q, ожидалась пустая строка", got)
	}
	if got := codecFromSPS(nil); got != "" {
		t.Errorf("пустой кадр: получено %q", got)
	}
}
