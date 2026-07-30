package main

import (
	"context"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type websocketMessageWriter interface {
	SetWriteDeadline(time.Time) error
	WriteMessage(messageType int, data []byte) error
}

type controlMessage struct {
	data []byte
	ack  chan error
}

// sessionOutbox разделяет управляющие сообщения и сжатое видео.
//
// Control нельзя терять из-за занятой видеоочереди: в нём лежат hello, fatal и подтверждение
// выбранной ступени качества. Видео, наоборот, нельзя копить — старый кадр только увеличивает
// задержку. Каналы намеренно не закрываются: producer может одновременно завершаться по
// disconnect, а закрытие общей очереди превращало штатную отмену в send on closed channel.
type sessionOutbox struct {
	ctx     context.Context
	control chan controlMessage
	video   chan []byte

	videoMu            sync.Mutex
	waitingForKeyframe bool
}

func newSessionOutbox(ctx context.Context, controlCapacity, videoCapacity int) *sessionOutbox {
	o := &sessionOutbox{
		ctx:     ctx,
		control: make(chan controlMessage, controlCapacity),
		video:   make(chan []byte, videoCapacity),
	}
	return o
}

// enqueueControl ждёт места в независимой control-очереди вместо молчаливого drop.
// waitDelivery нужен для terminal-сообщений вроде fatal: возврат означает, что writer уже
// передал сообщение в WebSocket, а не только принял его в память.
func (o *sessionOutbox) enqueueControl(data []byte, waitDelivery bool) error {
	if err := o.ctx.Err(); err != nil {
		return err
	}
	m := controlMessage{data: data}
	if waitDelivery {
		m.ack = make(chan error, 1)
	}
	select {
	case <-o.ctx.Done():
		return o.ctx.Err()
	case o.control <- m:
	}
	if m.ack == nil {
		return nil
	}
	select {
	case <-o.ctx.Done():
		return o.ctx.Err()
	case err := <-m.ack:
		return err
	}
}

// enqueueVideo возвращает два факта: поставлен ли кадр и надо ли запросить новый IDR.
// После любого gap цепочка P-кадров непригодна до ключевого кадра, поэтому backlog очищается,
// delta отбрасываются, а просьба keyframe выдаётся ровно один раз на эпизод восстановления.
func (o *sessionOutbox) enqueueVideo(data []byte, keyframe bool) (enqueued, requestKeyframe bool) {
	if o.ctx.Err() != nil {
		return false, false
	}
	o.videoMu.Lock()
	defer o.videoMu.Unlock()
	if o.ctx.Err() != nil {
		return false, false
	}

	if o.waitingForKeyframe {
		if !keyframe {
			return false, false
		}
		drainVideo(o.video)
		select {
		case o.video <- data:
			o.waitingForKeyframe = false
			return true, false
		default:
			return false, true
		}
	}

	select {
	case o.video <- data:
		return true, false
	default:
		drainVideo(o.video)
		if keyframe {
			select {
			case o.video <- data:
				return true, false
			default:
				o.waitingForKeyframe = true
				return false, true
			}
		}
		o.waitingForKeyframe = true
		return false, true
	}
}

func drainVideo(video chan []byte) {
	for {
		select {
		case <-video:
		default:
			return
		}
	}
}

func (o *sessionOutbox) writeLoop(w websocketMessageWriter) error {
	for {
		// Control получает приоритет, но проверка неблокирующая: при пустой очереди видео едет
		// без задержки. Отдельный select ниже не даёт writer крутить CPU.
		select {
		case m := <-o.control:
			if err := writeControl(w, m); err != nil {
				return err
			}
			continue
		default:
		}

		select {
		case <-o.ctx.Done():
			return o.ctx.Err()
		case m := <-o.control:
			if err := writeControl(w, m); err != nil {
				return err
			}
		case data := <-o.video:
			if err := writeWebSocketMessage(w, websocket.BinaryMessage, data); err != nil {
				return err
			}
		}
	}
}

func writeControl(w websocketMessageWriter, m controlMessage) error {
	err := writeWebSocketMessage(w, websocket.TextMessage, m.data)
	if m.ack != nil {
		m.ack <- err
	}
	return err
}

func writeWebSocketMessage(w websocketMessageWriter, messageType int, data []byte) error {
	if err := w.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return w.WriteMessage(messageType, data)
}
