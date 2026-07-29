//go:build linux

package main

import (
	"os"
	"os/exec"
	"strconv"
)

// Linux. Честная картина на 2026:
//   X11        — x11grab работает без плясок;
//   Wayland    — ffmpeg сам захватывать НЕ УМЕЕТ, поэтому идём через портал ScreenCast и
//                PipeWire (см. wayland_linux.go). Проверено на живой машине с KDE Plasma 6.
//   kmsgrab    — требует прав DRM-мастера и на живом сеансе KDE обычно недоступен.
// Ни один вариант не считается рабочим, пока не отдал КАДРЫ: кодировщик умеет «завестись»
// и молчать, и тогда клиент получает внятную причину, а не чёрный экран.
func captureOptions(width, height, fps int) []captureOption {
	f := strconv.Itoa(fps)
	var out []captureOption

	if testSource {
		return []captureOption{{source: "testsrc", encoder: "libx264",
			args: append(append(baseArgs(), "-f", "lavfi", "-i", "testsrc2=size="+size(width, height)+":rate="+f),
				encodeTail("libx264", fps, bitrate)...)}}
	}

	// Wayland — первым: под ним x11grab отдаёт пустоту, и перебирать его раньше значит
	// впустую жечь по 6 секунд на вариант.
	if waylandActive() {
		if opt, ok := waylandOption(width, height, fps); ok {
			out = append(out, opt)
		}
	}

	// В SSH-сессии DISPLAY пуст, хотя на машине может быть живой X-сервер — тогда вариант
	// x11grab просто не пробовался бы. Подставляем :0 и проверяем фактом наличия кадров.
	disp := os.Getenv("DISPLAY")
	if disp == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		disp = ":0"
	}
	if disp != "" {
		for _, enc := range []string{"h264_nvenc", "h264_vaapi", "libx264"} {
			args := append(baseArgs(), "-f", "x11grab", "-framerate", f, "-draw_mouse", "1", "-i", disp)
			if enc == "h264_vaapi" {
				args = append([]string{"-hide_banner", "-loglevel", "error", "-nostdin",
					"-vaapi_device", "/dev/dri/renderD128"}, args[len(baseArgs()):]...)
			}
			out = append(out, captureOption{source: "x11grab", encoder: enc,
				args: append(args, encodeTail(enc, fps, bitrate)...)})
		}
	}

	// kmsgrab: работает только с правами на DRM-мастера (root/CAP_SYS_ADMIN). Ставим последним —
	// пусть попробует, но рассчитывать на него нельзя.
	for _, enc := range []string{"h264_vaapi", "libx264"} {
		out = append(out, captureOption{source: "kmsgrab", encoder: enc,
			args: append(append([]string{"-hide_banner", "-loglevel", "error", "-nostdin",
				"-vaapi_device", "/dev/dri/renderD128", "-f", "kmsgrab", "-framerate", f, "-i", "-"},
				"-vf", "hwmap=derive_device=vaapi,scale_vaapi=format=nv12"),
				encodeTailNoFormat(enc, fps, bitrate)...)})
	}
	return out
}

func size(w, h int) string { return strconv.Itoa(w) + "x" + strconv.Itoa(h) }

// Для kmsgrab кадры уже в GPU-памяти в нужном формате — повторный format/hwupload сломает цепочку.
func encodeTailNoFormat(encoder string, fps, bitrateKbps int) []string {
	tail := encodeTail(encoder, fps, bitrateKbps)
	out := make([]string, 0, len(tail))
	for i := 0; i < len(tail); i++ {
		if tail[i] == "-vf" || tail[i] == "-pix_fmt" {
			i++ // пропустить и значение
			continue
		}
		out = append(out, tail[i])
	}
	return out
}

func configureProc(cmd *exec.Cmd) {}
