//go:build darwin

package main

import (
	"os/exec"
	"strconv"
)

// macOS: avfoundation отдаёт экран как устройство захвата, кодируем через VideoToolbox
// (аппаратный энкодер есть и на Intel, и на Apple Silicon).
//
// ВАЖНО для пользователя: при первом запуске система спросит разрешение Screen Recording,
// и без него захват вернёт чёрные кадры. Обойти это нельзя — так устроен macOS.
func captureOptions(width, height, fps int) []captureOption {
	f := strconv.Itoa(fps)
	if testSource {
		return []captureOption{{source: "testsrc", encoder: "libx264",
			args: append(append(baseArgs(), "-f", "lavfi", "-i", "testsrc2=size="+size(width, height)+":rate="+f),
				encodeTail("libx264", fps, bitrate)...)}}
	}
	var out []captureOption
	for _, enc := range []string{"h264_videotoolbox", "libx264"} {
		out = append(out, captureOption{source: "avfoundation", encoder: enc,
			args: append(append(baseArgs(),
				"-f", "avfoundation", "-capture_cursor", "1", "-framerate", f, "-i", "1:none"),
				encodeTail(enc, fps, bitrate)...)})
	}
	return out
}

func size(w, h int) string { return strconv.Itoa(w) + "x" + strconv.Itoa(h) }

func configureProc(cmd *exec.Cmd) {}
