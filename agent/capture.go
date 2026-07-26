package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Вариант захвата: как назвать в интерфейсе и с какими аргументами звать ffmpeg.
// Пробуем по порядку и берём ПЕРВЫЙ, который реально отдал кадры, — поэтому «нет NVENC»
// или «Wayland не пускает» не ломают трансляцию, а просто спускают на ступень ниже.
type captureOption struct {
	source  string
	encoder string
	args    []string
}

// AU — законченный access unit (кадр) H.264 в формате Annex-B.
type AU struct {
	Data  []byte
	IsKey bool
}

type Streamer struct {
	opts   []captureOption
	fps    int
	width  int
	height int

	mu      sync.Mutex
	chosen  captureOption
	cmd     *exec.Cmd
	lastErr string
}

func NewStreamer(fps, width, height int) *Streamer {
	return &Streamer{opts: captureOptions(width, height, fps), fps: fps, width: width, height: height}
}

func (s *Streamer) Chosen() captureOption {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.chosen
}

func (s *Streamer) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// Run перебирает варианты захвата, пока один не отдаст кадры, и гонит их в onAU до отмены.
// Возвращает ошибку, только если не завёлся НИ ОДИН вариант — тогда клиенту есть что показать.
func (s *Streamer) Run(ctx context.Context, onAU func(AU)) error {
	var problems []string
	for _, opt := range s.opts {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("пробую захват: source=%s encoder=%s", opt.source, opt.encoder)
		err := s.runOne(ctx, opt, onAU)
		if ctx.Err() != nil {
			return nil // штатная остановка
		}
		if err == nil {
			return nil
		}
		problems = append(problems, fmt.Sprintf("%s/%s: %v", opt.source, opt.encoder, err))
		s.mu.Lock()
		s.lastErr = err.Error()
		s.mu.Unlock()
	}
	return fmt.Errorf("ни один вариант захвата не заработал: %s", strings.Join(problems, "; "))
}

// firstFrameTimeout — сколько ждём первый кадр, прежде чем признать вариант нерабочим.
// Кодировщик может «завестись» и молчать (классика KRdp+NVIDIA — чёрный экран), поэтому
// критерий успеха именно КАДРЫ, а не код возврата процесса.
const firstFrameTimeout = 6 * time.Second

func (s *Streamer) runOne(ctx context.Context, opt captureOption, onAU func(AU)) error {
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()

	cmd := exec.CommandContext(cctx, ffmpegPath(), opt.args...)
	configureProc(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var errBuf strings.Builder
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("не удалось запустить ffmpeg: %w", err)
	}
	s.mu.Lock()
	s.cmd = cmd
	s.mu.Unlock()

	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := sc.Text()
			if errBuf.Len() < 4000 {
				errBuf.WriteString(line + "\n")
			}
		}
	}()

	first := make(chan struct{})
	var once sync.Once
	done := make(chan error, 1)
	go func() {
		done <- splitAnnexB(stdout, func(au AU) {
			// Запоминаем выбранный вариант ДО отдачи первого кадра: получатель формирует по нему
			// приветствие, и если сделать это позже — в приветствие уедут пустые значения.
			once.Do(func() {
				s.mu.Lock()
				s.chosen = opt
				s.mu.Unlock()
				close(first)
			})
			onAU(au)
		})
	}()

	select {
	case <-first:
		log.Printf("захват пошёл: source=%s encoder=%s", opt.source, opt.encoder)
		err := <-done
		_ = cmd.Wait()
		if cctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("поток оборвался: %v (%s)", err, tail(errBuf.String()))
	case <-time.After(firstFrameTimeout):
		cancel()
		_ = cmd.Wait()
		return fmt.Errorf("нет кадров за %s (%s)", firstFrameTimeout, tail(errBuf.String()))
	case <-cctx.Done():
		_ = cmd.Wait()
		return nil
	}
}

func tail(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 400 {
		s = "…" + s[len(s)-400:]
	}
	return strings.ReplaceAll(s, "\n", " | ")
}

// splitAnnexB режет поток Annex-B на access unit'ы.
//
// WebCodecs принимает не «байты как пришли», а ЦЕЛЫЕ кадры, поэтому поток надо собирать самим.
//
// Наивное правило «новый VCL-NAL = новый кадр» НЕВЕРНО, и это поймал тест: x264 с preset
// ultrafast включает slice-threading и режет ОДИН кадр на несколько слайсов — получалось 35
// «кадров» там, где их 7. Настоящая граница кадра — слайс с first_mb_in_slice == 0, а это,
// по синтаксису H.264, ue(v) в самом начале слайс-хедера: значение 0 ⇔ первый бит равен 1.
func splitAnnexB(r io.Reader, onAU func(AU)) error {
	br := bufio.NewReaderSize(r, 1<<20)
	buf := make([]byte, 0, 1<<20)
	var hasVCL, isKey bool

	flush := func() {
		if len(buf) == 0 {
			return
		}
		out := make([]byte, len(buf))
		copy(out, buf)
		onAU(AU{Data: out, IsKey: isKey})
		buf = buf[:0]
		hasVCL, isKey = false, false
	}

	// Скользящее окно для поиска стартовых кодов 00 00 01 / 00 00 00 01.
	var zeros int
	pending := make([]byte, 0, 4)
	for {
		b, err := br.ReadByte()
		if err != nil {
			flush()
			return err
		}
		if b == 0x00 {
			zeros++
			pending = append(pending, b)
			continue
		}
		if b == 0x01 && zeros >= 2 {
			// Начало NAL. Смотрим вперёд заголовок и первый байт полезной нагрузки.
			hdr, err := br.Peek(2)
			if err != nil {
				flush()
				return err
			}
			t := hdr[0] & 0x1f
			isVCL := t >= 1 && t <= 5
			// AUD (9) — явный маркер границы, если кодировщик его ставит.
			// Иначе граница = первый слайс кадра (first_mb_in_slice == 0 ⇔ старший бит взведён).
			firstSlice := isVCL && hdr[1]&0x80 != 0
			if (firstSlice || t == 9) && hasVCL {
				flush()
			}
			if isVCL {
				hasVCL = true
			}
			if t == 5 || t == 7 {
				isKey = true
			}
			// Стартовый код пишем канонический, 4-байтовый.
			buf = append(buf, 0x00, 0x00, 0x00, 0x01)
			zeros = 0
			pending = pending[:0]
			continue
		}
		// Не стартовый код — вернуть накопленные нули и текущий байт в тело NAL.
		for i := 0; i < zeros; i++ {
			buf = append(buf, 0x00)
		}
		buf = append(buf, b)
		zeros = 0
		pending = pending[:0]
		if len(buf) > 32<<20 { // предохранитель от разрастания на битом потоке
			buf = buf[:0]
		}
	}
}
