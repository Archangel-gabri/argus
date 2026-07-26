package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Server struct {
	token string
	fps   int
	w, h  int

	mu     sync.Mutex
	busy   bool // один зритель за раз: второй ffmpeg только грел бы машину
	upgr   websocket.Upgrader
}

func NewServer(token string, fps, w, h int) *Server {
	return &Server{
		token: token, fps: fps, w: w, h: h,
		upgr: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 1 << 20,
			// Проверять Origin бессмысленно: клиент — десктопное приложение, а не сайт.
			// Единственная реальная защита здесь — токен, выданный по SSH при провижининге.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

func (s *Server) authOK(r *http.Request) bool {
	t := r.URL.Query().Get("token")
	if t == "" {
		t = r.Header.Get("X-Argus-Token")
	}
	return subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
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
	if !s.authOK(r) {
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

	conn, err := s.upgr.Upgrade(w, r, nil)
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
			sendJSON(Hello{
				Type: "hello", Version: Version, OS: goos(),
				Encoder: ch.encoder, Source: ch.source,
				Width: s.w, Height: s.h, FPS: s.fps,
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
