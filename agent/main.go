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
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("argus-agent %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return
	}
	testSource = *test
	bitrate = *br

	if *selftest {
		runSelfTest(*fps, *width, *height)
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
	log.Printf("argus-agent %s слушает %s (%s/%s, fps=%d)", Version, *addr, runtime.GOOS, runtime.GOARCH, *fps)
	log.Fatal(httpSrv.Serve(ln))
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
	ctx, cancel := contextWithTimeout(25 * time.Second)
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
	fmt.Printf("захват: НЕ РАБОТАЕТ — %v\n", err)
	os.Exit(1)
}
