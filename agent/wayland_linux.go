//go:build linux

package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "embed"
)

// Захват экрана на Wayland.
//
// На Wayland композитор не отдаёт картинку никому просто так: ни x11grab, ни kmsgrab здесь
// не работают. Единственный поддерживаемый путь — портал ScreenCast, который после согласия
// хозяина машины отдаёт поток через PipeWire. Согласие спрашивается один раз: портал выдаёт
// токен восстановления, дальше сеанс поднимается молча.
//
// Клиент портала — отдельный скрипт на Python, а не код на Go, по трезвой причине: разговор
// с порталом идёт по D-Bus с подписками на сигналы, а рабочая реализация этого разговора уже
// есть и проверена на живой машине. Скрипт вшит в бинарь и разворачивается рядом с агентом,
// так что распространяется агент по-прежнему одним файлом.

//go:embed helpers/portal-screencast.py
var portalScript []byte

// waylandActive — есть ли вообще смысл идти этим путём.
func waylandActive() bool {
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		return true
	}
	// В SSH-сессии переменных сеанса нет, но сокет композитора на месте — по нему и определяем.
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = "/run/user/" + strconv.Itoa(os.Getuid())
	}
	_, err := os.Stat(filepath.Join(dir, "wayland-0"))
	return err == nil
}

// startPortal поднимает сеанс трансляции и возвращает номер узла PipeWire.
// Сеанс живёт, пока жив процесс клиента, поэтому возвращаем и способ его прекратить.
func startPortal() (node string, stop func(), err error) {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".argus")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", nil, err
	}
	script := filepath.Join(dir, "portal-screencast.py")
	// Перезаписываем всегда: агент мог обновиться, а старый скрипт остаться.
	if err := os.WriteFile(script, portalScript, 0o700); err != nil {
		return "", nil, err
	}

	cmd := exec.Command("python3", script)
	cmd.Env = append(os.Environ(), "ARGUS_HOLD=1")
	ensureSessionEnv(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return "", nil, fmt.Errorf("не удалось запустить клиент портала: %w", err)
	}
	kill := func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}

	// Ждём ответа портала. Долго: при ПЕРВОМ запуске на экране машины висит диалог согласия,
	// и его должен кто-то подтвердить. Дальше, с токеном восстановления, ответ приходит сразу.
	type res struct {
		node string
		err  error
	}
	ch := make(chan res, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if n, ok := strings.CutPrefix(line, "NODE="); ok {
				ch <- res{node: n}
				return
			}
			if e, ok := strings.CutPrefix(line, "ERROR="); ok {
				ch <- res{err: errors.New(e)}
				return
			}
		}
		ch <- res{err: errors.New("клиент портала завершился, не отдав поток")}
	}()

	select {
	case r := <-ch:
		if r.err != nil {
			kill()
			return "", nil, r.err
		}
		return r.node, kill, nil
	case <-time.After(90 * time.Second):
		kill()
		return "", nil, errors.New(
			"портал не ответил за 90с — вероятно, на экране машины ждёт подтверждения диалог доступа к экрану")
	}
}

// gstArgs — конвейер от узла PipeWire до H.264 Annex-B на стандартный вывод. Формат тот же,
// что даёт ffmpeg, поэтому дальше по цепочке (нарезка на кадры, отправка) менять нечего.
func gstArgs(node string, width, height, fps int) []string {
	caps := fmt.Sprintf("video/x-raw,format=I420,width=%d,height=%d", width, height)
	return []string{
		"-q",
		"pipewiresrc", "path=" + node, "always-copy=true",
		"!", "videoconvert",
		"!", "videoscale",
		"!", caps,
		"!", "x264enc", "tune=zerolatency", "speed-preset=ultrafast",
		"bitrate=" + strconv.Itoa(bitrate), "key-int-max=" + strconv.Itoa(fps*2),
		"!", "h264parse", "config-interval=1",
		"!", "video/x-h264,stream-format=byte-stream,alignment=au",
		"!", "fdsink", "fd=1",
	}
}

// waylandOption — вариант захвата для Wayland, если в системе есть чем его выполнить.
func waylandOption(width, height, fps int) (captureOption, bool) {
	gst, err := exec.LookPath("gst-launch-1.0")
	if err != nil {
		return captureOption{}, false
	}
	if _, err := exec.LookPath("python3"); err != nil {
		return captureOption{}, false
	}
	return captureOption{
		source:  "pipewire-portal",
		encoder: "x264",
		bin:     gst,
		prepare: func() ([]string, func(), error) {
			node, stop, err := startPortal()
			if err != nil {
				return nil, nil, err
			}
			return gstArgs(node, width, height, fps), stop, nil
		},
	}, true
}

// ensureSessionEnv добавляет переменные графического сеанса, если процесс запущен из-под SSH
// (там их нет), — иначе клиент портала не найдёт ни шину, ни композитор.
func ensureSessionEnv(cmd *exec.Cmd) {
	uid := strconv.Itoa(os.Getuid())
	run := os.Getenv("XDG_RUNTIME_DIR")
	if run == "" {
		run = "/run/user/" + uid
		cmd.Env = append(cmd.Env, "XDG_RUNTIME_DIR="+run)
	}
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		cmd.Env = append(cmd.Env, "DBUS_SESSION_BUS_ADDRESS=unix:path="+filepath.Join(run, "bus"))
	}
	if os.Getenv("WAYLAND_DISPLAY") == "" {
		cmd.Env = append(cmd.Env, "WAYLAND_DISPLAY=wayland-0")
	}
}
