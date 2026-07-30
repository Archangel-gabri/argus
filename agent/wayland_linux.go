//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

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

//go:embed helpers/portal-stream.py
var portalStreamScript []byte

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

// Цепочка кодировщика — СЕРЕДИНА конвейера. Источник, очередь, масштаб и хвост собирает
// помощник (helpers/portal-stream.py): настоящий размер экрана известен только после ответа
// портала, то есть уже внутри его процесса.
//
// Элемент кодировщика обязан называться `enc` — по этому имени помощник находит его, чтобы
// менять битрейт на живом конвейере.
type waylandEncoder struct {
	name    string               // как показать в интерфейсе
	fps     int                  // сколько кадров имеет смысл просить у этого пути
	scaleTo int                  // 0 = родное разрешение; иначе предел по высоте
	chain   func(fps int) string // звенья от преобразования формата до кодировщика включительно
}

// Каскад от аппаратного к программному. Порядок задан от быстрого к медленному, а РЕШАЕТ, как
// и везде в агенте, факт пришедших кадров: элемента может не быть в системе, кодировщик может
// «создаться» и молчать.
var waylandEncoders = []waylandEncoder{
	{
		// БЕЗ преобразования формата: кадр уходит в NVENC таким, каким его отдал композитор
		// (портал даёт BGRx/BGRA, и nvh264enc их принимает). Автор плагина nvcodec объясняет,
		// что NVENC всё равно запускает CUDA-ядро под преобразование, поэтому сделать это ОДИН
		// раз внутри кодировщика быстрее, чем гонять кадр через videoconvert или cudaupload —
		// замеры сообщества дают разницу примерно втрое.
		name: "nvenc", fps: 60,
		chain: nvencChain,
	},
	{
		// Запасной аппаратный путь: если формат источника кодировщику не подошёл, приводим
		// к NV12 на процессоре. Дороже, но лучше, чем скатиться на программное кодирование.
		name: "nvenc", fps: 60,
		chain: func(fps int) string {
			return "videoconvert ! video/x-raw,format=NV12 ! " + nvencChain(fps)
		},
	},
	{
		name: "vaapi", fps: 60,
		chain: func(fps int) string {
			return "videoconvert ! video/x-raw,format=NV12 ! vapostproc ! vah264enc name=enc " +
				"target-usage=7 rate-control=cbr bitrate=" + strconv.Itoa(bitrate) +
				" key-int-max=" + strconv.Itoa(fps*2)
		},
	},
	{
		// Программный путь: родное разрешение ему не по силам, поэтому уменьшаем — но СТРОГО
		// с сохранением пропорций (искажённая картинка хуже уменьшенной).
		name: "x264", fps: 30, scaleTo: 1080,
		chain: func(fps int) string {
			return "videoconvert ! video/x-raw,format=I420 ! x264enc name=enc " +
				"tune=zerolatency speed-preset=ultrafast bitrate=" + strconv.Itoa(bitrate) +
				" key-int-max=" + strconv.Itoa(fps*2)
		},
	},
}

func nvencChain(fps int) string {
	// SPS/PPS перед КАЖДЫМ ключевым кадром: у nvh264enc это по умолчанию выключено, а WebCodecs
	// в режиме annexb требует заголовки внутри ключевого чанка — иначе клиент, подключившийся
	// не с начала, не сможет настроить декодер.
	// Битрейт и интервал ключевых кадров ОБЯЗАТЕЛЬНЫ: без них nvh264enc берёт битрейт
	// «автоматически» и на анимации во весь экран выдавал 60 Мбит/с вместо 8 — канал такого
	// не выдержит, а разница видна только замером.
	return "nvh264enc name=enc preset=p1 tune=ultra-low-latency rc-mode=cbr " +
		"zerolatency=true bframes=0 repeat-sequence-header=true bitrate=" + strconv.Itoa(bitrate) +
		" gop-size=" + strconv.Itoa(fps*2)
}

// fitAspect уменьшает картинку до maxHeight, СОХРАНЯЯ пропорции, и возвращает чётные размеры.
// Тот же расчёт делает помощник — здесь он остаётся для проверок и для ffmpeg-путей.
func fitAspect(w, h, maxHeight int) (int, int) {
	if maxHeight <= 0 || h <= maxHeight {
		return w - w%2, h - h%2
	}
	nw := w * maxHeight / h
	return nw - nw%2, maxHeight - maxHeight%2
}

// helperPath разворачивает помощника рядом с агентом. Перезаписываем всегда: агент мог
// обновиться, а старый скрипт остаться — это уже приводило к разбору по устаревшему формату.
func helperPath() (string, error) {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".argus")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	script := filepath.Join(dir, "portal-stream.py")
	if err := os.WriteFile(script, portalStreamScript, 0o700); err != nil {
		return "", err
	}
	return script, nil
}

// waylandOptions — варианты захвата для Wayland, если в системе есть чем их выполнить.
func waylandOptions(_, _, fallbackFPS int) []captureOption {
	py, err := exec.LookPath("python3")
	if err != nil {
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
			bin:     py,
			fps:     fps,
			control: true,
			prepare: func() ([]string, func(), *captureDims, error) {
				script, err := helperPath()
				if err != nil {
					return nil, nil, nil, err
				}
				// Размеры придут событием от помощника ДО первого кадра — здесь их ещё нет,
				// и выдумывать их нельзя.
				return []string{script, enc.chain(fps), strconv.Itoa(enc.scaleTo)}, nil,
					&captureDims{fps: fps}, nil
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
