package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Server struct {
	token string
	fps   int
	w, h  int

	mu   sync.Mutex
	busy bool // один зритель за раз: второй ffmpeg только грел бы машину
	upgr websocket.Upgrader
}

func NewServer(token string, fps, w, h int) *Server {
	return &Server{
		token: token, fps: fps, w: w, h: h,
		upgr: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 1 << 20,
			CheckOrigin:     allowOrigin,
		},
	}
}

// tokenProto — префикс подпротокола WebSocket, которым клиент передаёт токен.
// Браузерный WebSocket не умеет ставить заголовки, а тащить секрет в URL нельзя:
// строка запроса оседает в логах прокси и серверов. Подпротокол — единственный
// штатный способ передать значение в рукопожатии.
const tokenProto = "argus.token."

func (s *Server) equal(t string) bool {
	return subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func (s *Server) authOK(r *http.Request) bool {
	if t := r.Header.Get("X-Argus-Token"); t != "" {
		return s.equal(t)
	}
	// Query оставлен только для ручной диагностики курлом на своей же машине;
	// Argus им не пользуется и по нему нельзя открыть поток (см. handleStream).
	return s.equal(r.URL.Query().Get("token"))
}

// wsToken достаёт токен из предложенных клиентом подпротоколов.
func wsToken(r *http.Request) (string, string) {
	for _, p := range websocket.Subprotocols(r) {
		if strings.HasPrefix(p, tokenProto) {
			return strings.TrimPrefix(p, tokenProto), p
		}
	}
	return "", ""
}

// allowOrigin отсекает подключения из браузера.
//
// Кросс-доменные WebSocket-подключения браузер НЕ блокирует — проверять Origin обязан сервер.
// Без этого вредоносная страница через DNS rebinding (перепривязку своего домена на адрес
// машины) стучится в агент как «свой». Наш клиент — окно Electron, оно грузится с file://
// и присылает Origin: null либо не присылает вовсе. Любой http(s)-Origin — это страница, и ей
// здесь делать нечего.
func allowOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" || o == "null" || strings.HasPrefix(o, "file://") {
		return hostIsAddress(r.Host)
	}
	return false
}

// hostIsAddress — вторая половина защиты от rebinding: при подмене DNS в Host приезжает
// ДОМЕННОЕ имя атакующего, а легальный клиент всегда обращается по адресу.
func hostIsAddress(host string) bool {
	h := host
	if v, _, err := net.SplitHostPort(host); err == nil {
		h = v
	}
	if h == "" || h == "localhost" {
		return true
	}
	return net.ParseIP(strings.Trim(h, "[]")) != nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !s.authOK(r) {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]any{"ok": false, "version": Version, "error": "bad token"})
			return
		}
		s.mu.Lock()
		busy := s.busy
		s.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "version": Version, "os": goos(), "busy": busy, "fps": s.fps,
		})
	})
	mux.HandleFunc("/stream", s.handleStream)
	return mux
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	// Поток авторизуется ТОЛЬКО подпротоколом: токен не должен попадать в строку запроса,
	// иначе он оседает в логах любого промежуточного узла.
	tok, proto := wsToken(r)
	if !s.equal(tok) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		http.Error(w, "уже идёт трансляция для другого клиента", http.StatusConflict)
		return
	}
	s.busy = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.busy = false
		s.mu.Unlock()
	}()

	// Выбранный подпротокол обязан быть отражён в ответе, иначе браузер разорвёт соединение.
	conn, err := s.upgr.Upgrade(w, r, http.Header{"Sec-WebSocket-Protocol": {proto}})
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()
	log.Printf("клиент подключился: %s", r.RemoteAddr)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	inj, injErr := newInjector()
	if injErr != nil {
		log.Printf("управление недоступно: %v", injErr)
		inj = &noopInjector{reason: injErr.Error()}
	}
	defer inj.Close()

	// Пишем в сокет только из ОДНОЙ горутины — gorilla это требует.
	out := make(chan []byte, 64)
	var writeOnce sync.Once
	stop := func() { writeOnce.Do(func() { close(out) }) }
	defer stop()

	go func() {
		for msg := range out {
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			mt := websocket.BinaryMessage
			if len(msg) > 0 && msg[0] == '{' {
				mt = websocket.TextMessage
			}
			if err := conn.WriteMessage(mt, msg); err != nil {
				cancel()
				return
			}
		}
	}()

	// Ввод от клиента.
	go func() {
		defer cancel()
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if mt != websocket.TextMessage {
				continue
			}
			var m InputMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m.Type {
			case "mouse":
				inj.Mouse(m.X, m.Y, m.Buttons)
			case "wheel":
				inj.Wheel(m.Delta)
			case "key":
				inj.Key(m.Code, m.Down)
			}
		}
	}()

	st := NewStreamer(s.fps, s.w, s.h)
	sentHello := false
	sendJSON := func(v any) {
		b, _ := json.Marshal(v)
		select {
		case out <- b:
		default:
		}
	}

	err = st.Run(ctx, func(au AU) {
		if !sentHello {
			sentHello = true
			ch := st.Chosen()
			// Размеры и частоту берём У ПОТОКА, а не из флагов запуска: на мониторе 3440×1440
			// флаги говорили «1920×1080», и клиент растягивал картинку в чужие пропорции.
			d := st.Dims()
			sendJSON(Hello{
				Type: "hello", Version: Version, OS: goos(),
				Encoder: ch.encoder, Source: ch.source,
				Width: d.width, Height: d.height, FPS: d.fps,
				// baseline/main-профиль, который отдают наши настройки кодировщиков
				Codec: "avc1.42E01F",
			})
		}
		flag := byte(0)
		if au.IsKey {
			flag = 1
		}
		msg := make([]byte, 0, len(au.Data)+1)
		msg = append(msg, flag)
		msg = append(msg, au.Data...)
		select {
		case out <- msg:
		default:
			// Клиент не успевает — рвать сеанс из-за этого нельзя, просто пропускаем кадр.
		}
	})
	if err != nil && ctx.Err() == nil {
		log.Printf("захват не завёлся: %v", err)
		sendJSON(Fatal{Type: "fatal", Error: "не удалось начать захват экрана", Detail: err.Error()})
		time.Sleep(300 * time.Millisecond) // дать сообщению уйти до закрытия сокета
	}
}
