package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// Проверка отсечения браузерных подключений. Кросс-доменный WebSocket браузер не блокирует,
// поэтому вся защита от DNS rebinding живёт здесь — и должна быть проверена, а не предположена.
func TestAllowOrigin(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		host   string
		want   bool
	}{
		{"окно Electron (file://)", "file:///app/screen.html", "100.74.94.24:47990", true},
		{"Origin отсутствует", "", "192.168.0.5:47990", true},
		{"Origin null", "null", "127.0.0.1:47990", true},
		{"сайт из браузера", "https://evil.example", "100.74.94.24:47990", false},
		{"сайт по http", "http://evil.example", "127.0.0.1:47990", false},
		// Классический rebinding: Origin пустой, но обращаются по ДОМЕНУ атакующего.
		{"DNS rebinding по домену", "", "evil.example:47990", false},
		{"домен без порта", "", "attacker.tld", false},
		{"localhost допустим", "", "localhost:47990", true},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/stream", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := allowOrigin(r); got != c.want {
			t.Errorf("%s: allowOrigin = %v, ожидалось %v", c.name, got, c.want)
		}
	}
}

// Токен не должен приниматься из строки запроса: URL оседает в логах промежуточных узлов.
func TestStreamRejectsQueryToken(t *testing.T) {
	const tok = "0123456789abcdef0123456789abcdef"
	srv := httptest.NewServer(NewServer(tok, 30, 640, 360).Handler())
	defer srv.Close()
	ws := "ws" + strings.TrimPrefix(srv.URL, "http")

	// 1. Токен в query — должен быть отвергнут.
	_, resp, err := websocket.DefaultDialer.Dial(ws+"/stream?token="+tok, nil)
	if err == nil {
		t.Fatal("поток открылся по токену из строки запроса — так быть не должно")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("ожидался 401 на query-токен, получено: %v", resp)
	}

	// 2. Неверный токен в подпротоколе — тоже отказ.
	d := websocket.Dialer{Subprotocols: []string{tokenProto + "wrong"}}
	_, resp, err = d.Dial(ws+"/stream", nil)
	if err == nil {
		t.Fatal("поток открылся с неверным токеном")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("ожидался 401 на неверный токен, получено: %v", resp)
	}
}

// Верный токен в подпротоколе должен пускать, и сервер обязан ОТРАЗИТЬ выбранный подпротокол:
// без этого браузер рвёт соединение сразу после рукопожатия.
func TestStreamAcceptsSubprotocol(t *testing.T) {
	const tok = "0123456789abcdef0123456789abcdef"
	testSource = true
	bitrate = 2000
	srv := httptest.NewServer(NewServer(tok, 15, 320, 180).Handler())
	defer srv.Close()
	ws := "ws" + strings.TrimPrefix(srv.URL, "http")

	proto := tokenProto + tok
	d := websocket.Dialer{Subprotocols: []string{proto}}
	c, resp, err := d.Dial(ws+"/stream", nil)
	if err != nil {
		t.Fatalf("поток не открылся с верным токеном: %v", err)
	}
	defer c.Close()
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != proto {
		t.Fatalf("сервер не отразил подпротокол: %q (браузер разорвал бы связь)", got)
	}
	if c.Subprotocol() != proto {
		t.Errorf("согласованный подпротокол = %q", c.Subprotocol())
	}
}

// Диагностический /health намеренно принимает заголовок; query оставлен только для curl.
func TestHealthPrefersHeader(t *testing.T) {
	const tok = "0123456789abcdef0123456789abcdef"
	srv := httptest.NewServer(NewServer(tok, 30, 640, 360).Handler())
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/health", nil)
	req.Header.Set("X-Argus-Token", tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Errorf("health с верным заголовком вернул %d", res.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodGet, srv.URL+"/health", nil)
	req2.Header.Set("X-Argus-Token", "wrong")
	res2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusUnauthorized {
		t.Errorf("health с неверным заголовком вернул %d, ожидался 401", res2.StatusCode)
	}
}
