// argus-agent — тонкий агент трансляции экрана и удалённого управления для Argus.
//
// Зачем он есть: RDP требует пароль учётной записи ОС и живёт только на Windows. Агент
// ставится по SSH (а SSH-доступ уже доказывает контроль над машиной), получает от Argus свой
// токен — и пароль ОС из цепочки исчезает совсем. Один протокол на Windows/Linux/macOS.
//
// Захват и кодирование делает ffmpeg: своя реализация под каждую ОС и каждый аппаратный
// кодировщик — это чужая многолетняя работа, которую нет смысла повторять.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var (
	testSource bool
	bitrate    int
)

func goos() string { return runtime.GOOS }

func main() {
	var (
		addr     = flag.String("addr", "0.0.0.0:47990", "адрес прослушивания")
		token    = flag.String("token", "", "токен доступа (или файл через --token-file, или ARGUS_AGENT_TOKEN)")
		tokenF   = flag.String("token-file", defaultTokenFile(), "файл с токеном")
		fps      = flag.Int("fps", 30, "кадров в секунду")
		width    = flag.Int("width", 1920, "ширина (для тестового источника)")
		height   = flag.Int("height", 1080, "высота (для тестового источника)")
		br       = flag.Int("bitrate", 8000, "битрейт, кбит/с")
		test     = flag.Bool("test-source", false, "вместо экрана — тестовая картинка (проверка тракта без прав на захват)")
		showVer  = flag.Bool("version", false, "показать версию и выйти")
		selftest = flag.Bool("selftest", false, "проверить окружение (ffmpeg, кодировщики, ввод) и выйти")
		bench    = flag.Int("bench", 0, "замер: сколько секунд гнать захват и посчитать кадры/битрейт, потом выйти")
		only     = flag.String("only", "", "замер только вариантов, чей кодировщик содержит эту подстроку (nvenc, x264…)")
		certDir  = flag.String("cert-dir", "", "каталог сертификата TLS (по умолчанию — рядом с файлом токена)")
		showFP   = flag.Bool("fingerprint", false, "напечатать отпечаток сертификата (SHA-256) и выйти")
		plain    = flag.Bool("no-tls", false, "без TLS — только для отладки на localhost")
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("argus-agent %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return
	}
	testSource = *test
	bitrate = *br

	dir := *certDir
	if dir == "" {
		dir = filepath.Dir(*tokenF)
	}

	// Отпечаток печатается ДО всего остального: провижининг Argus читает его по SSH сразу
	// после установки и запоминает (TOFU), чтобы потом принимать только этот сертификат.
	if *showFP {
		cp, _, err := ensureCert(dir)
		if err != nil {
			log.Fatalf("сертификат: %v", err)
		}
		fp, err := certFingerprint(cp)
		if err != nil {
			log.Fatalf("отпечаток: %v", err)
		}
		fmt.Printf("sha256:%s\n", fp)
		return
	}

	if *selftest {
		runSelfTest(*fps, *width, *height)
		return
	}

	if *bench > 0 {
		runBench(*bench, *fps, *width, *height, *only)
		return
	}

	tok := *token
	if tok == "" {
		tok = os.Getenv("ARGUS_AGENT_TOKEN")
	}
	if tok == "" && *tokenF != "" {
		if b, err := os.ReadFile(*tokenF); err == nil {
			tok = strings.TrimSpace(string(b))
		}
	}
	if tok == "" {
		log.Fatalf("не задан токен: --token, --token-file (%s) или ARGUS_AGENT_TOKEN", *tokenF)
	}

	srv := NewServer(tok, *fps, *width, *height)
	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("не удалось занять %s: %v", *addr, err)
	}

	if *plain {
		// Открытый транспорт оставлен только для отладки: по локальной сети токен и картинка
		// пошли бы без шифрования. В обычной работе этот флаг не используется.
		log.Printf("argus-agent %s слушает %s БЕЗ TLS (%s/%s, fps=%d)", Version, *addr, runtime.GOOS, runtime.GOARCH, *fps)
		log.Fatal(httpSrv.Serve(ln))
	}

	cp, kp, err := ensureCert(dir)
	if err != nil {
		log.Fatalf("сертификат: %v", err)
	}
	fp, _ := certFingerprint(cp)
	log.Printf("argus-agent %s слушает %s по TLS (%s/%s, fps=%d, отпечаток sha256:%s)",
		Version, *addr, runtime.GOOS, runtime.GOARCH, *fps, fp)
	log.Fatal(httpSrv.ServeTLS(ln, cp, kp))
}

func defaultTokenFile() string {
	switch runtime.GOOS {
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "Argus", "agent.token")
		}
	case "darwin":
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, "Library", "Application Support", "Argus", "agent.token")
		}
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".argus", "agent.token")
	}
	return ""
}

// runSelfTest — диагностика окружения БЕЗ подключения клиента: есть ли ffmpeg, какой вариант
// захвата реально отдаёт кадры и работает ли инъекция ввода. Именно это Argus зовёт после
// установки, чтобы сказать пользователю правду, а не «должно работать».
func runSelfTest(fps, w, h int) {
	fmt.Printf("argus-agent %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)

	ff := ffmpegPath()
	if p, err := lookPath(ff); err != nil {
		fmt.Printf("ffmpeg: НЕ НАЙДЕН (%s)\n", ff)
	} else {
		fmt.Printf("ffmpeg: %s\n", p)
	}

	inj, err := newInjector()
	if err != nil {
		fmt.Printf("управление: НЕТ — %v\n", err)
	} else {
		fmt.Printf("управление: есть\n")
		inj.Close()
	}

	fmt.Println("проверяю захват (первый рабочий вариант):")
	st := NewStreamer(fps, w, h)
	// Бюджет считаем от ЧИСЛА вариантов и от БОЛЬШЕГО из сроков ожидания: вариант, который жив
	// и молчит, ждут patienceTimeout, и если считать по firstFrameTimeout, самотест обрывается
	// на середине перебора и сообщает «<nil>» вместо настоящей причины.
	budget := time.Duration(len(st.opts)+1) * (patienceTimeout + time.Second)
	ctx, cancel := contextWithTimeout(budget)
	defer cancel()
	frames := 0
	done := make(chan error, 1)
	go func() {
		done <- st.Run(ctx, func(AU) {
			frames++
			if frames == 15 {
				cancel()
			}
		})
	}()
	err = <-done
	ch := st.Chosen()
	if frames > 0 {
		fmt.Printf("захват: РАБОТАЕТ — source=%s encoder=%s (кадров получено: %d)\n", ch.source, ch.encoder, frames)
		return
	}
	reason := "ни один вариант не отдал кадров"
	if err != nil {
		reason = err.Error()
	} else if last := st.LastError(); last != "" {
		reason = last
	}
	if ctx.Err() != nil {
		reason = "перебор не уложился в отведённое время; последняя ошибка: " + reason
	}
	fmt.Printf("захват: НЕ РАБОТАЕТ — %s\n", reason)
	os.Exit(1)
}

// runBench — замер пропускной способности выбранного пути захвата.
//
// Нужен потому, что самотест обрывается на пятнадцатом кадре: он отвечает на вопрос «работает
// ли», а не «сколько выдаёт». Здесь считаются кадры и байты за отведённое время, и по ним видно
// то, ради чего вообще делался аппаратный путь. Замер честен ровно настолько, насколько на
// экране в этот момент что-то происходит: источник на Wayland отдаёт кадры только при
// изменениях картинки, поэтому мерить надо под нагрузкой (например, анимацией во весь экран).
func runBench(seconds, fps, w, h int, only string) {
	st := NewStreamer(fps, w, h)
	if only != "" {
		var kept []captureOption
		for _, o := range st.opts {
			if strings.Contains(o.encoder, only) {
				kept = append(kept, o)
			}
		}
		if len(kept) == 0 {
			fmt.Printf("замер: нет вариантов с кодировщиком «%s»\n", only)
			os.Exit(1)
		}
		st.opts = kept
	}

	ctx, cancel := contextWithTimeout(time.Duration(seconds)*time.Second + patienceTimeout*time.Duration(len(st.opts)))
	defer cancel()

	var frames, bytes, keys int
	var firstAt time.Time
	done := make(chan error, 1)
	go func() {
		done <- st.Run(ctx, func(au AU) {
			if frames == 0 {
				firstAt = time.Now()
				// Отсчёт времени идёт от ПЕРВОГО кадра, а не от запуска: в запуск входят
				// переговоры с порталом и перебор вариантов, и они смазали бы результат.
				go func() {
					<-time.After(time.Duration(seconds) * time.Second)
					cancel()
				}()
			}
			frames++
			bytes += len(au.Data)
			if au.IsKey {
				keys++
			}
		})
	}()
	<-done

	ch := st.Chosen()
	d := st.Dims()
	if frames == 0 {
		fmt.Printf("замер: кадров не было (source=%s encoder=%s) — на экране ничего не менялось или путь не работает\n",
			ch.source, ch.encoder)
		os.Exit(1)
	}
	elapsed := time.Since(firstAt).Seconds()
	if elapsed <= 0 {
		elapsed = float64(seconds)
	}
	fmt.Printf("замер: source=%s encoder=%s %dx%d заявлено %d к/с\n", ch.source, ch.encoder, d.width, d.height, d.fps)
	fmt.Printf("  кадров: %d за %.1fс = %.1f к/с (ключевых %d)\n", frames, elapsed, float64(frames)/elapsed, keys)
	fmt.Printf("  поток: %.1f Мбит/с, средний кадр %.0f КБ\n",
		float64(bytes)*8/elapsed/1e6, float64(bytes)/float64(frames)/1024)
}
