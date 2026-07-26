package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

// ffmpegPath — сначала ffmpeg РЯДОМ с агентом (так его кладёт провижининг Argus, чтобы не
// зависеть от того, что установлено у пользователя), потом системный из PATH.
func ffmpegPath() string {
	name := "ffmpeg"
	if runtime.GOOS == "windows" {
		name = "ffmpeg.exe"
	}
	if exe, err := os.Executable(); err == nil {
		local := filepath.Join(filepath.Dir(exe), name)
		if st, err := os.Stat(local); err == nil && !st.IsDir() {
			return local
		}
	}
	return name
}

// encodeTail — общий хвост команды: параметры кодировщика + вывод сырого Annex-B в stdout.
//
// Ключевое для низкой задержки: никакого B-кадра и лукахеда (кодировщик не должен копить
// кадры), и заголовки SPS/PPS повторяются на каждом ключевом кадре — иначе клиент,
// подключившийся в середине потока, не сможет инициализировать декодер.
func encodeTail(encoder string, fps, bitrateKbps int) []string {
	gop := strconv.Itoa(fps * 2)
	a := []string{"-an", "-pix_fmt", "yuv420p"}

	switch encoder {
	case "h264_nvenc":
		a = append(a, "-c:v", "h264_nvenc",
			"-preset", "p1", "-tune", "ll", "-rc", "cbr", "-zerolatency", "1",
			"-bf", "0", "-g", gop, "-b:v", fmt.Sprintf("%dk", bitrateKbps))
	case "h264_qsv":
		a = append(a, "-c:v", "h264_qsv", "-preset", "veryfast", "-bf", "0",
			"-g", gop, "-b:v", fmt.Sprintf("%dk", bitrateKbps))
	case "h264_amf":
		a = append(a, "-c:v", "h264_amf", "-usage", "ultralowlatency", "-bf", "0",
			"-g", gop, "-b:v", fmt.Sprintf("%dk", bitrateKbps))
	case "h264_videotoolbox":
		a = append(a, "-c:v", "h264_videotoolbox", "-realtime", "1",
			"-g", gop, "-b:v", fmt.Sprintf("%dk", bitrateKbps))
	case "h264_vaapi":
		// VAAPI требует загрузки кадров в GPU-память перед кодированием.
		a = append(a, "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi",
			"-g", gop, "-b:v", fmt.Sprintf("%dk", bitrateKbps))
	default: // libx264
		a = append(a, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
			"-bf", "0", "-g", gop, "-b:v", fmt.Sprintf("%dk", bitrateKbps))
	}

	// dump_extra повторяет SPS/PPS перед каждым ключевым кадром — без этого клиент,
	// подключившийся не с начала потока, видит чёрный экран до перезапуска трансляции.
	a = append(a, "-bsf:v", "dump_extra=freq=keyframe", "-f", "h264", "pipe:1")
	return a
}

// baseArgs — общее начало: без баннера, только ошибки в stderr, без буферизации вывода.
func baseArgs() []string {
	return []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "nobuffer", "-flags", "low_delay"}
}
