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

// portalStream — что отдал портал: узел PipeWire и РОДНОЕ разрешение экрана.
// Разрешение важно не меньше узла: пока его не спрашивали, конвейер приводил картинку к
// 1920×1080, и на мониторе 3440×1440 пропорции 21:9 молча превращались в 16:9.
type portalStream struct {
	node   string
	width  int
	height int
}

// startPortal поднимает сеанс трансляции и возвращает узел PipeWire с размерами экрана.
// Сеанс живёт, пока жив процесс клиента, поэтому возвращаем и способ его прекратить.
func startPortal() (stream portalStream, stop func(), err error) {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".argus")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return portalStream{}, nil, err
	}
	script := filepath.Join(dir, "portal-screencast.py")
	// Перезаписываем всегда: агент мог обновиться, а старый скрипт остаться.
	if err := os.WriteFile(script, portalScript, 0o700); err != nil {
		return portalStream{}, nil, err
	}

	cmd := exec.Command("python3", script)
	cmd.Env = append(os.Environ(), "ARGUS_HOLD=1")
	ensureSessionEnv(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return portalStream{}, nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return portalStream{}, nil, fmt.Errorf("не удалось запустить клиент портала: %w", err)
	}
	kill := func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}

	// Ждём ответа портала. Долго: при ПЕРВОМ запуске на экране машины висит диалог согласия,
	// и его должен кто-то подтвердить. Дальше, с токеном восстановления, ответ приходит сразу.
	// Размер приходит ОТДЕЛЬНОЙ строкой и может прийти как до NODE=, так и после, поэтому
	// читаем до конца строки NODE=, запоминая последний увиденный размер.
	type res struct {
		stream portalStream
		err    error
	}
	ch := make(chan res, 1)
	go func() {
		var w, h int
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if s, ok := strings.CutPrefix(line, "SIZE="); ok {
				w, h = parseSize(s)
				continue
			}
			if n, ok := strings.CutPrefix(line, "NODE="); ok {
				ch <- res{stream: portalStream{node: n, width: w, height: h}}
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
			return portalStream{}, nil, r.err
		}
		return r.stream, kill, nil
	case <-time.After(90 * time.Second):
		kill()
		return portalStream{}, nil, errors.New(
			"портал не ответил за 90с — вероятно, на экране машины ждёт подтверждения диалог доступа к экрану")
	}
}

// parseSize разбирает строку вида «(3440, 1440)», которую печатает клиент портала.
// Размеры приводятся к ЧЁТНЫМ: H.264 кодирует макроблоками, и нечётная сторона либо
// отвергается кодировщиком, либо молча обрезается — лучше решить это здесь.
func parseSize(s string) (int, int) {
	s = strings.NewReplacer("(", "", ")", "", " ", "").Replace(s)
	parts := strings.Split(s, ",")
	if len(parts) != 2 {
		return 0, 0
	}
	w, err1 := strconv.Atoi(parts[0])
	h, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || w <= 0 || h <= 0 {
		return 0, 0
	}
	return w - w%2, h - h%2
}

// Каскад кодировщиков на Wayland: от аппаратного к программному.
//
// Раньше здесь был жёстко зашит x264 — то есть кадры 3440×1440 жевал процессор, пока рядом
// простаивал NVENC. Порядок задан от быстрого к медленному, а РЕШАЕТ, как и везде в агенте,
// факт пришедших кадров: элемента может не быть в системе, кодировщик может «создаться» и
// молчать. Вариант, который умер сразу, стоит уже не 6 секунд, а мгновение (см. capture.go).
//
// Аппаратный путь идёт в РОДНОМ разрешении и до 60 к/с. Программный ограничен 30 к/с и, если
// экран выше 1080 строк, уменьшается — но СТРОГО с сохранением пропорций: искажённая картинка
// хуже уменьшенной.
type waylandEncoder struct {
	name    string                              // как показать в интерфейсе
	fps     int                                 // сколько кадров имеет смысл просить у этого пути
	scaleTo int                                 // 0 = родное разрешение; иначе ограничение по высоте
	build   func(dims [2]int, fps int) []string // звенья от videoconvert до h264parse
}

var waylandEncoders = []waylandEncoder{
	{
		// БЕЗ videoconvert и БЕЗ cudaupload — кадр уходит в NVENC в том формате, в каком его
		// отдал композитор (портал даёт BGRx/BGRA, и nvh264enc их принимает напрямую).
		//
		// Это не экономия строчки, а исправление: автор плагина nvcodec объясняет, что NVENC
		// всё равно запускает CUDA-ядро под преобразование формата, поэтому сделать это ОДИН
		// раз внутри кодировщика быстрее, чем гонять кадр через cudaupload+cudaconvert.
		// Замеры сообщества дают разницу примерно втрое. Большинство руководств советует
		// обратное — но у них нет замеров.
		name: "nvenc", fps: 60,
		build: func(_ [2]int, fps int) []string { return nvencChain(fps)[1:] },
	},
	{
		// Запасной аппаратный путь: если формат источника кодировщику не подошёл, приводим
		// к NV12 на процессоре. Дороже, но лучше, чем скатиться на программное кодирование.
		name: "nvenc", fps: 60,
		build: func(_ [2]int, fps int) []string {
			return append([]string{"videoconvert", "!", "video/x-raw,format=NV12"}, nvencChain(fps)...)
		},
	},
	{
		name: "vaapi", fps: 60,
		build: func(_ [2]int, fps int) []string {
			return []string{
				"videoconvert", "!", "video/x-raw,format=NV12", "!", "vapostproc", "!", "vah264enc",
				"bitrate=" + strconv.Itoa(bitrate), "key-int-max=" + strconv.Itoa(fps*2),
				"target-usage=7", "rate-control=cbr",
			}
		},
	},
	{
		name: "x264", fps: 30, scaleTo: 1080,
		build: func(_ [2]int, fps int) []string {
			return []string{
				"videoconvert", "!", "video/x-raw,format=I420", "!", "x264enc",
				"tune=zerolatency", "speed-preset=ultrafast",
				"bitrate=" + strconv.Itoa(bitrate), "key-int-max=" + strconv.Itoa(fps*2),
			}
		},
	},
}

func nvencChain(fps int) []string {
	return []string{
		"!", "nvh264enc",
		"preset=p1", "tune=ultra-low-latency", "rc-mode=cbr", "zerolatency=true", "bframes=0",
		// SPS/PPS перед КАЖДЫМ ключевым кадром. У nvh264enc это по умолчанию выключено, а
		// WebCodecs в режиме annexb требует заголовки внутри каждого ключевого чанка —
		// без них клиент, подключившийся не с начала, не сможет настроить декодер.
		"repeat-sequence-header=true",
		"bitrate=" + strconv.Itoa(bitrate), "gop-size=" + strconv.Itoa(fps*2),
	}
}

// fitAspect уменьшает картинку до maxHeight, СОХРАНЯЯ пропорции, и возвращает чётные размеры.
// Ноль в maxHeight или картинка ниже предела — оставляем как есть.
func fitAspect(w, h, maxHeight int) (int, int) {
	if maxHeight <= 0 || h <= maxHeight {
		return w - w%2, h - h%2
	}
	nw := w * maxHeight / h
	return nw - nw%2, maxHeight - maxHeight%2
}

// gstArgs — конвейер от узла PipeWire до H.264 Annex-B на стандартный вывод. Формат тот же,
// что даёт ffmpeg, поэтому дальше по цепочке (нарезка на кадры, отправка) менять нечего.
func gstArgs(enc waylandEncoder, st portalStream, w, h, fps int) []string {
	args := []string{
		"-q",
		"pipewiresrc", "path=" + st.node, "always-copy=true",
		// keepalive-time — настройка ключевая, а не тонкая. KWin объявляет ПЕРЕМЕННУЮ частоту
		// (framerate=0/1) и отдаёт кадр только при изменениях картинки, а KPipeWire вдобавок
		// выбрасывает дубликаты: у людей доходило до «закодирован 1 кадр из 10». Без keepalive
		// поток на спокойном экране просто замолкает — именно это и выглядело как «просадки»
		// и как «исправный вариант не отдаёт кадров». С ним источник периодически перевысылает
		// последний буфер: трансляция остаётся живой, а проверка варианта перестаёт зависеть от
		// того, шевелится ли что-то на экране.
		"keepalive-time=120",
		// queue с leaky=downstream роняет СТАРЫЕ кадры вместо того, чтобы притормозить захват:
		// в трансляции опоздавший кадр бесполезен, а остановка конвейера видна как заикание.
		"!", "queue", "leaky=downstream", "max-size-buffers=3", "max-size-bytes=0", "max-size-time=0",
		// ЧАСТОТУ ЗДЕСЬ НЕ ОГРАНИЧИВАЕМ. Это не упущение, а вывод из трёх проверок на живой машине:
		//
		//   1. Договор с источником (`video/x-raw,framerate=[1/1,60/1]` сразу за pipewiresrc)
		//      роняет переговоры целиком — «streaming stopped, reason not-negotiated».
		//   2. `videorate max-rate=N drop-only=true` даёт 1 кадр за 10 секунд. Он придерживает
		//      кадр, чтобы посчитать темп по двум соседним, и на этом источнике это фатально.
		//   3. Попытка №2 повторена ПОСЛЕ включения keepalive-time (поток стал непрерывным, и
		//      казалось, что причина устранена) — результат тот же. Больше не пробовать.
		//
		// Поэтому отдаём столько, сколько даёт композитор: на стенде монитор 144 Гц, и после
		// того как из конвейера ушёл videoconvert, NVENC успевает за всеми 144 при ~8 Мбит/с.
		// Для локальной сети это дешево, а настоящее ограничение частоты требует управляемого
		// конвейера (сброс кадров pad-probe'ом) — это отдельная работа по подстройке качества.
	}
	if w != st.width || h != st.height {
		args = append(args, "!", "videoscale", "!",
			fmt.Sprintf("video/x-raw,width=%d,height=%d", w, h))
	}
	args = append(args, "!")
	args = append(args, enc.build([2]int{w, h}, fps)...)
	return append(args,
		// config-interval=-1 — «вставлять SPS/PPS перед каждым ключевым кадром», а не раз в
		// секунду, как было при 1. Регистрация AVC в WebCodecs требует заголовки ВНУТРИ каждого
		// ключевого чанка: иначе клиент, подключившийся между ключевыми кадрами, не может
		// настроить декодер и видит чёрный экран до следующей секунды.
		"!", "h264parse", "config-interval=-1",
		"!", "video/x-h264,stream-format=byte-stream,alignment=au",
		"!", "fdsink", "fd=1",
	)
}

// waylandOptions — варианты захвата для Wayland, если в системе есть чем их выполнить.
func waylandOptions(fallbackW, fallbackH, fallbackFPS int) []captureOption {
	gst, err := exec.LookPath("gst-launch-1.0")
	if err != nil {
		return nil
	}
	if _, err := exec.LookPath("python3"); err != nil {
		return nil
	}

	out := make([]captureOption, 0, len(waylandEncoders))
	for _, enc := range waylandEncoders {
		enc := enc
		fps := enc.fps
		if fps <= 0 {
			fps = fallbackFPS
		}
		out = append(out, captureOption{
			source:  "pipewire-portal",
			encoder: enc.name,
			bin:     gst,
			fps:     fps,
			prepare: func() ([]string, func(), *captureDims, error) {
				st, stop, err := startPortal()
				if err != nil {
					return nil, nil, nil, err
				}
				// Портал мог не сообщить размер — тогда работаем по значениям по умолчанию,
				// но не выдаём их за правду: сюда попадёт то же, что уедет клиенту.
				if st.width == 0 || st.height == 0 {
					st.width, st.height = fallbackW, fallbackH
				}
				w, h := fitAspect(st.width, st.height, enc.scaleTo)
				return gstArgs(enc, st, w, h, fps), stop,
					&captureDims{width: w, height: h, fps: fps}, nil
			},
		})
	}
	return out
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
