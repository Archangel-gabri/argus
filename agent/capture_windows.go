//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

// Windows: сначала ddagrab (Desktop Duplication, кадры остаются в GPU и сразу идут в NVENC —
// самый дешёвый путь), затем универсальный gdigrab, затем софт-энкод. Какой вариант реально
// отдаст кадры, решается в рантайме по факту, а не по наличию железа.
func captureOptions(width, height, fps int) []captureOption {
	f := strconv.Itoa(fps)
	var out []captureOption

	if testSource {
		out = append(out, captureOption{source: "testsrc", encoder: "libx264",
			args: append(append(baseArgs(), "-f", "lavfi", "-i", "testsrc2=size="+size(width, height)+":rate="+f),
				encodeTail("libx264", fps, bitrate)...)})
		return out
	}

	// ddagrab отдаёт кадры в d3d11-памяти — NVENC забирает их без копирования в RAM.
	out = append(out, captureOption{source: "ddagrab", encoder: "h264_nvenc",
		args: append(append(baseArgs(),
			"-init_hw_device", "d3d11va", "-filter_complex", "ddagrab=output_idx=0:framerate="+f),
			encodeTail("h264_nvenc", fps, bitrate)...)})

	for _, enc := range []string{"h264_nvenc", "h264_amf", "h264_qsv", "libx264"} {
		out = append(out, captureOption{source: "gdigrab", encoder: enc,
			args: append(append(baseArgs(),
				"-f", "gdigrab", "-framerate", f, "-draw_mouse", "1", "-i", "desktop"),
				encodeTail(enc, fps, bitrate)...)})
	}
	return out
}

func size(w, h int) string { return strconv.Itoa(w) + "x" + strconv.Itoa(h) }

// Без этого при запуске ffmpeg на Windows выскакивает окно консоли поверх рабочего стола —
// то есть пользователь на той стороне видит мигающее окно при каждом подключении.
func configureProc(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
