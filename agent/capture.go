package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
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
	// bin — чем запускать. Пусто = ffmpeg. На Wayland захват идёт через GStreamer, потому что
	// ffmpeg просто не умеет читать поток PipeWire, который отдаёт композитор.
	bin string
	// prepare — подготовка перед запуском: вернуть окончательные аргументы, уборку за собой и,
	// если стали известны, реальные размеры картинки. Нужна там, где аргументы известны только
	// после переговоров: номер узла PipeWire выдаёт портал, и узнать его заранее нельзя.
	prepare func() ([]string, func(), *captureDims, error)
	// control — вариант принимает команды строками JSON в свой stdin (помощник конвейера).
	// Только у таких можно менять качество, не переоткрывая сеанс портала.
	control bool
	// fps — сколько кадров даёт ИМЕННО этот вариант. Аппаратный кодировщик тянет 60, программный
	// честно ограничен 30. Ноль = как задано флагом.
	fps int
}

// captureDims — что реально поехало в поток. Раньше клиенту сообщались размеры из флагов
// (1920×1080), а конвейер к ним же и приводил картинку — на мониторе 3440×1440 это молча
// ломало пропорции 21:9 до 16:9. Теперь источник размеров один: сам поток.
type captureDims struct {
	width  int
	height int
	fps    int
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
	dims    captureDims
	codec   string
	// dimsFromHelper — размеры сообщил сам помощник (событие приходит ДО первого кадра).
	// Без этого признака установка размеров на первом кадре затирала бы правду догадкой.
	dimsFromHelper bool
	// ctrl — управляющий канал к помощнику конвейера (его stdin). Есть только у вариантов,
	// которые умеют менять качество на ходу.
	ctrlMu sync.Mutex
	ctrl   io.WriteCloser
}

func NewStreamer(fps, width, height int) *Streamer {
	return &Streamer{
		opts:   captureOptions(width, height, fps),
		fps:    fps,
		width:  width,
		height: height,
		dims:   captureDims{width: width, height: height, fps: fps},
		codec:  defaultCodec,
	}
}

func (s *Streamer) Chosen() captureOption {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.chosen
}

// Codec — строка кодека, собранная из заголовка настоящего потока (см. codecFromSPS).
func (s *Streamer) Codec() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.codec
}

// Dims — размеры и частота ТОГО, что реально едет клиенту. До первого кадра это значения по
// умолчанию; после — то, что сообщил сам источник.
func (s *Streamer) Dims() captureDims {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dims
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
		// Причину неудачи КАЖДОГО варианта пишем в журнал сразу. Без этого каскад молчал:
		// в логе было видно только «пробую», и разобраться, почему аппаратный кодировщик не
		// поехал, можно было лишь по итоговой ошибке — а её видно только если не завёлся НИ ОДИН.
		log.Printf("вариант не подошёл: source=%s encoder=%s — %v", opt.source, opt.encoder, err)
		problems = append(problems, fmt.Sprintf("%s/%s: %v", opt.source, opt.encoder, err))
		s.mu.Lock()
		s.lastErr = err.Error()
		s.mu.Unlock()
	}
	return fmt.Errorf("ни один вариант захвата не заработал: %s", strings.Join(problems, "; "))
}

// firstFrameTimeout — сколько ждём первый кадр, прежде чем засомневаться в варианте.
// Кодировщик может «завестись» и молчать (классика KRdp+NVIDIA — чёрный экран), поэтому
// критерий успеха именно КАДРЫ, а не код возврата процесса.
const firstFrameTimeout = 6 * time.Second

// patienceTimeout — сколько ещё ждём, если конвейер ЖИВ и молчит без единой жалобы.
//
// На Wayland источник отдаёт кадры только при изменениях картинки, поэтому «кадров нет» на
// спокойном рабочем столе — это не поломка. Экран мы перед проверкой шевелим уведомлением
// (nudge_linux.go), но уведомления может не быть в системе, поэтому запас терпения нужен:
// иначе исправный аппаратный путь отвергается, и владелец без причины получает картинку с
// процессора. Ждём молча живущий конвейер, а вот умерший или пожаловавшийся отбраковываем сразу.
const patienceTimeout = 20 * time.Second

func (s *Streamer) runOne(ctx context.Context, opt captureOption, onAU func(AU)) error {
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()

	bin := opt.bin
	if bin == "" {
		bin = ffmpegPath()
	}
	args := opt.args
	dims := captureDims{width: s.width, height: s.height, fps: s.fps}
	if opt.fps > 0 {
		dims.fps = opt.fps
	}
	if opt.prepare != nil {
		prepared, cleanup, prepDims, err := opt.prepare()
		if err != nil {
			return err
		}
		if cleanup != nil {
			defer cleanup()
		}
		args = prepared
		if prepDims != nil {
			if prepDims.width > 0 && prepDims.height > 0 {
				dims.width, dims.height = prepDims.width, prepDims.height
			}
			if prepDims.fps > 0 {
				dims.fps = prepDims.fps
			}
		}
	}
	cmd := exec.CommandContext(cctx, bin, args...)
	configureProc(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	// Управляющий канал открываем ТОЛЬКО тем вариантам, которые его понимают: лишний stdin
	// у ffmpeg безвреден, но обещать через него управление качеством было бы неправдой.
	var ctrl io.WriteCloser
	if opt.control {
		ctrl, err = cmd.StdinPipe()
		if err != nil {
			return err
		}
	}
	var errBuf strings.Builder
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("не удалось запустить %s: %w", bin, err)
	}
	s.mu.Lock()
	s.cmd = cmd
	s.dimsFromHelper = false
	s.mu.Unlock()
	s.ctrlMu.Lock()
	s.ctrl = ctrl
	s.ctrlMu.Unlock()
	defer func() {
		s.ctrlMu.Lock()
		s.ctrl = nil
		if ctrl != nil {
			_ = ctrl.Close()
		}
		s.ctrlMu.Unlock()
	}()

	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := sc.Text()
			// Наш помощник конвейера пишет в этот же канал СОБЫТИЯ строками JSON. Отличить их
			// от обычного вывода ffmpeg просто: там нет поля «ev». Разбор здесь, а не отдельным
			// дескриптором, потому что порядок строк относительно ошибок важен, а один канал
			// его гарантирует.
			if ev, ok := parseHelperEvent(line); ok {
				s.applyHelperEvent(ev)
				if ev.Ev != "error" {
					continue
				}
			}
			if errBuf.Len() < 4000 {
				errBuf.WriteString(line + "\n")
			}
		}
	}()

	first := make(chan struct{})
	var once sync.Once
	done := make(chan error, 1)
	// Шевелим экран, чтобы источнику было что отдать: без изменения картинки исправный
	// конвейер на Wayland молчит и выглядит сломанным.
	stopNudge := make(chan struct{})
	defer close(stopNudge)
	nudgeSoon(stopNudge)
	go func() {
		done <- splitAnnexB(stdout, func(au AU) {
			// Запоминаем выбранный вариант ДО отдачи первого кадра: получатель формирует по нему
			// приветствие, и если сделать это позже — в приветствие уедут пустые значения.
			once.Do(func() {
				// Строку кодека берём из ПЕРВОГО кадра: h264parse с config-interval=1 ставит
				// SPS перед каждым ключевым, а первый кадр всегда ключевой.
				codec := codecFromSPS(au.Data)
				s.mu.Lock()
				s.chosen = opt
				if s.dimsFromHelper {
					// Помощник уже сообщил настоящий размер — берём только частоту.
					s.dims.fps = dims.fps
				} else {
					s.dims = dims
				}
				if codec != "" {
					s.codec = codec
				}
				s.mu.Unlock()
				close(first)
			})
			onAU(au)
		})
	}()

	select {
	case <-first:
		log.Printf("захват пошёл: source=%s encoder=%s (%dx%d, %d к/с)",
			opt.source, opt.encoder, dims.width, dims.height, dims.fps)
		err := <-done
		_ = cmd.Wait()
		if cctx.Err() != nil {
			return nil
		}
		return fmt.Errorf("поток оборвался: %v (%s)", err, tail(errBuf.String()))
	// Вариант может умереть мгновенно — например, в системе нет такого элемента GStreamer.
	// Без этой ветки каждый такой вариант отнимал полные 6 секунд ожидания кадра, и перебор
	// каскада из трёх кодировщиков стоил 18 секунд до первой картинки.
	case err := <-done:
		_ = cmd.Wait()
		if cctx.Err() != nil {
			return nil
		}
		// Кадры всё-таки были? Тогда это обрыв уже РАБОТАВШЕГО потока, а не неудачный вариант, —
		// причина у них разная, и путать их в сообщении нельзя.
		select {
		case <-first:
			return fmt.Errorf("поток оборвался: %v (%s)", err, tail(errBuf.String()))
		default:
			return fmt.Errorf("вариант не запустился: %v (%s)", err, tail(errBuf.String()))
		}
	case <-time.After(firstFrameTimeout):
		// Кадров нет. Если конвейер при этом жив и ни на что не жалуется — на Wayland это
		// скорее неподвижный экран, чем поломка. Даём ему второй, больший срок.
		if errText := strings.TrimSpace(errBuf.String()); errText != "" {
			cancel()
			_ = cmd.Wait()
			return fmt.Errorf("нет кадров за %s (%s)", firstFrameTimeout, tail(errText))
		}
		log.Printf("кадров пока нет, но конвейер жив и молчит — жду ещё %s (source=%s encoder=%s)",
			patienceTimeout-firstFrameTimeout, opt.source, opt.encoder)
		select {
		case <-first:
			log.Printf("захват пошёл: source=%s encoder=%s (%dx%d, %d к/с)",
				opt.source, opt.encoder, dims.width, dims.height, dims.fps)
			err := <-done
			_ = cmd.Wait()
			if cctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("поток оборвался: %v (%s)", err, tail(errBuf.String()))
		case err := <-done:
			_ = cmd.Wait()
			if cctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("вариант не запустился: %v (%s)", err, tail(errBuf.String()))
		case <-time.After(patienceTimeout - firstFrameTimeout):
			cancel()
			_ = cmd.Wait()
			return fmt.Errorf("нет кадров за %s (%s)", patienceTimeout, tail(errBuf.String()))
		case <-cctx.Done():
			_ = cmd.Wait()
			return nil
		}
	case <-cctx.Done():
		_ = cmd.Wait()
		return nil
	}
}

// defaultCodec — чем отвечаем, если в кадре не нашлось SPS. Baseline 3.1 — самое безопасное
// предположение: его понимает любой декодер. Но именно предположение, а не факт.
const defaultCodec = "avc1.42E01F"

// codecFromSPS собирает строку кодека для WebCodecs из НАСТОЯЩЕГО заголовка потока.
//
// Строка не косметика: по ней клиент настраивает VideoDecoder, и аппаратный декодер вправе
// отказаться, если объявленный уровень ниже фактического. Раньше здесь стояло зашитое
// «avc1.42E01F» — Baseline, уровень 3.1, то есть примерно 1280×720. Живой поток на мониторе
// 3440×1440 оказался уровня 6.0 (level_idc=60): объявленное и фактическое расходились так,
// что запрос на аппаратное декодирование мог быть отклонён.
//
// Формат по спецификации: avc1.PPCCLL, где PP — profile_idc, CC — байт ограничений,
// LL — level_idc, все в шестнадцатеричном виде. Все три байта лежат сразу за заголовком
// NAL типа 7 (SPS).
func codecFromSPS(au []byte) string {
	for i := 0; i+7 < len(au); i++ {
		if au[i] != 0 || au[i+1] != 0 {
			continue
		}
		// Стартовый код бывает трёх- и четырёхбайтовым — учитываем оба.
		var nal int
		switch {
		case au[i+2] == 1:
			nal = i + 3
		case au[i+2] == 0 && au[i+3] == 1:
			nal = i + 4
		default:
			continue
		}
		if nal+3 >= len(au) || au[nal]&0x1f != 7 {
			continue
		}
		return fmt.Sprintf("avc1.%02X%02X%02X", au[nal+1], au[nal+2], au[nal+3])
	}
	return ""
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

// ── События помощника конвейера ────────────────────────────────────────────────────────────────

// helperEvent — строка JSON, которую пишет helpers/portal-stream.py в свой fd 2.
// Каналы разведены намеренно: в fd 1 идёт двоичный H.264 и ничего кроме него, иначе журнал
// попал бы прямо в видеопоток.
type helperEvent struct {
	Ev      string `json:"ev"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Node    int    `json:"node"`
	Reused  bool   `json:"reused"`
	Encoder string `json:"encoder"`
	Error   string `json:"error"`
	Detail  string `json:"detail"`
}

func parseHelperEvent(line string) (helperEvent, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "{") || !strings.Contains(line, `"ev"`) {
		return helperEvent{}, false
	}
	var ev helperEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil || ev.Ev == "" {
		return helperEvent{}, false
	}
	return ev, true
}

func (s *Streamer) applyHelperEvent(ev helperEvent) {
	switch ev.Ev {
	case "stream":
		// Настоящий размер картинки известен только после ответа портала, то есть уже внутри
		// помощника. Приходит ДО первого кадра, поэтому в приветствие попадает верным.
		if ev.Width > 0 && ev.Height > 0 {
			s.mu.Lock()
			s.dims.width, s.dims.height = ev.Width, ev.Height
			s.dimsFromHelper = true
			s.mu.Unlock()
		}
		log.Printf("портал отдал поток: узел %d, %dx%d (согласие переиспользовано: %v)",
			ev.Node, ev.Width, ev.Height, ev.Reused)
	case "ready":
		log.Printf("конвейер собран: %s", ev.Encoder)
	case "applied":
		log.Printf("качество применено: %s", ev.Detail)
	case "error":
		log.Printf("помощник конвейера: %s %s", ev.Error, ev.Detail)
	}
}

// SetQuality меняет качество У ЖИВОГО конвейера, без переоткрытия сеанса портала.
//
// Работает только с помощником (Wayland): у него сохранена ссылка на элемент кодировщика, а
// свойство битрейта помечено «changeable in PLAYING» — кодировщик применит его на следующем
// кадре. Для вариантов на ffmpeg управлять нечем, и это честно возвращается ошибкой.
func (s *Streamer) SetQuality(bitrateKbps, fps int) error {
	s.ctrlMu.Lock()
	defer s.ctrlMu.Unlock()
	ctrl := s.ctrl
	if ctrl == nil {
		return errors.New("этот вариант захвата не умеет менять качество на ходу")
	}
	var b strings.Builder
	if bitrateKbps > 0 {
		fmt.Fprintf(&b, `{"cmd":"set-bitrate","kbps":%d}`+"\n", bitrateKbps)
	}
	if fps >= 0 {
		fmt.Fprintf(&b, `{"cmd":"set-fps","fps":%d}`+"\n", fps)
	}
	if b.Len() == 0 {
		return nil
	}
	_, err := io.WriteString(ctrl, b.String())
	return err
}

// RequestKeyframe просит немедленный ключевой кадр — восстановление после потери.
func (s *Streamer) RequestKeyframe() error {
	s.ctrlMu.Lock()
	defer s.ctrlMu.Unlock()
	ctrl := s.ctrl
	if ctrl == nil {
		return errors.New("этот вариант захвата не умеет выдавать ключевой кадр по требованию")
	}
	_, err := io.WriteString(ctrl, `{"cmd":"keyframe"}`+"\n")
	return err
}
