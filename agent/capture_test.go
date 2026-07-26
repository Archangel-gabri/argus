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
