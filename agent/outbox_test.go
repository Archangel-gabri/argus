package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestOutboxDropsBacklogAndWaitsForKeyframe(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := newSessionOutbox(ctx, 2, 2)

	if ok, request := o.enqueueVideo([]byte("delta-1"), false); !ok || request {
		t.Fatalf("первый delta не принят: ok=%v request=%v", ok, request)
	}
	if ok, request := o.enqueueVideo([]byte("delta-2"), false); !ok || request {
		t.Fatalf("второй delta не принят: ok=%v request=%v", ok, request)
	}
	if ok, request := o.enqueueVideo([]byte("overflow"), false); ok || !request {
		t.Fatalf("переполнение не запустило восстановление: ok=%v request=%v", ok, request)
	}
	if got := len(o.video); got != 0 {
		t.Fatalf("после переполнения остался backlog из %d кадров", got)
	}

	// Повторные delta не должны ни ехать в повреждённую цепочку, ни спамить просьбами IDR.
	for i := 0; i < 5; i++ {
		if ok, request := o.enqueueVideo([]byte("delta-after-gap"), false); ok || request {
			t.Fatalf("delta во время восстановления: ok=%v request=%v", ok, request)
		}
	}

	if ok, request := o.enqueueVideo([]byte("keyframe"), true); !ok || request {
		t.Fatalf("ключевой кадр не восстановил очередь: ok=%v request=%v", ok, request)
	}
	if ok, request := o.enqueueVideo([]byte("delta-after-key"), false); !ok || request {
		t.Fatalf("delta после ключевого кадра не принят: ok=%v request=%v", ok, request)
	}
}

func TestOutboxControlIsIndependentFromVideoBacklog(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o := newSessionOutbox(ctx, 1, 1)

	if ok, _ := o.enqueueVideo([]byte("video"), false); !ok {
		t.Fatal("не удалось заполнить видеоочередь")
	}
	if err := o.enqueueControl([]byte(`{"type":"fatal"}`), false); err != nil {
		t.Fatalf("полная видеоочередь заблокировала control: %v", err)
	}
	if got := len(o.control); got != 1 {
		t.Fatalf("control не попал в отдельную очередь: len=%d", got)
	}
}

func TestOutboxCancelWhileSending(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	o := newSessionOutbox(ctx, 1, 1)
	w := &recordingMessageWriter{}
	done := make(chan error, 1)
	go func() { done <- o.writeLoop(w) }()

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				o.enqueueVideo([]byte("frame"), j%10 == 0)
				_ = o.enqueueControl([]byte(`{"type":"quality"}`), false)
			}
		}()
	}
	cancel()
	wg.Wait()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("writer завершился не отменой: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("writer не завершился после disconnect/cancel")
	}
	if ok, _ := o.enqueueVideo([]byte("late"), true); ok {
		t.Error("кадр принят после отмены сеанса")
	}
	if err := o.enqueueControl([]byte(`{"type":"late"}`), false); !errors.Is(err, context.Canceled) {
		t.Fatalf("control после отмены вернул %v", err)
	}
}

type recordedMessage struct {
	typ  int
	data []byte
}

type recordingMessageWriter struct {
	mu       sync.Mutex
	messages []recordedMessage
}

func (w *recordingMessageWriter) SetWriteDeadline(time.Time) error { return nil }

func (w *recordingMessageWriter) WriteMessage(typ int, data []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.messages = append(w.messages, recordedMessage{typ: typ, data: append([]byte(nil), data...)})
	if typ != websocket.TextMessage && typ != websocket.BinaryMessage {
		return errors.New("неизвестный тип WebSocket-сообщения")
	}
	return nil
}
