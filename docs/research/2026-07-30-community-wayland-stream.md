# Community-ресёрч: захват Wayland → NVENC → WebSocket → WebCodecs

**Дата:** 2026-07-30 · **Для:** агент трансляции Argus (`projects/Nexus-One/agent/`)
**Метод:** community-dig — читались КОММЕНТАРИИ и ответы в обсуждениях, не только исходные посты.
Приоритет — слова мейнтейнеров и исходный код: Nicolas Dufresne, Matthew Waters, Sebastian Dröge,
Olivier Crête, **Seungha Yang (автор плагина nvcodec)**, Arun Raghavan и George Kiagiadakis (PipeWire),
**Vlad Zahorodnii, Nate Graham, Aleix Pol, David Redondo, Méven Car, Harald Sitter, Xaver Hugl
(Zamundaaa)** — KDE/KWin, **Dale Curtis, Dan Sanders, Eugene Zemtsov** — Chrome WebCodecs,
Paul Adenot — Mozilla, Cameron Gutman — Moonlight, @ehfd — Selkies.

> Каждое утверждение — со ссылкой на конкретное обсуждение/issue/коммит. Где мнения расходятся —
> см. «ПРОТИВОРЕЧИЯ». Часть выводов проверена на живой KWin 6.6.5 и в исходниках KWin/PipeWire.

---

## 0. Наш стенд, текущий конвейер и три главные находки

Целевая машина — **ПК Castiel**: Arch + KDE Plasma 6 Wayland, RTX 3060, драйвер 610.x.

Текущий конвейер — `agent/wayland_linux.go:117-131`:

```
pipewiresrc path=<node> always-copy=true
  ! videoconvert ! videoscale ! video/x-raw,format=I420,width=W,height=H
  ! x264enc tune=zerolatency speed-preset=ultrafast bitrate=<N> key-int-max=<fps*2>
  ! h264parse config-interval=1
  ! video/x-h264,stream-format=byte-stream,alignment=au
  ! fdsink fd=1
```

Портал — `agent/helpers/portal-screencast.py`: `types=1`, `cursor_mode=2`, **`persist_mode=2`**,
`restore_token` читается из файла и **перезаписывается новым** после `Start` (это правильно).
Декодер — `src/renderer/src/lib/agentClient.ts:84-95`:
`configure({ codec: hello.codec || 'avc1.42E01F', optimizeForLatency: true })`, без `description`.

### 🔴 Три находки, которые меняют план работ

**1. Наши «просадки кадров» — это, скорее всего, damage-driven захват, а не нехватка мощности.**
KWin отдаёт `framerate = 0/1` («variable rate capture»): кадр появляется только когда что-то
изменилось, а дубликаты KPipeWire **выбрасывает**. Лечится `keepalive-time` (§2.1) — у нас его нет.

**2. `videoconvert` + `x264enc` надо заменить не на `cudaupload ! cudaconvert ! nvh264enc`,
а прямо на `nvh264enc`.** Автор плагина nvcodec говорит, что конвертация внутри NVENC **быстрее**,
а бенчмарк даёт **~3×** разницу в пользу «скормить BGRx напрямую» (§1.1). Это противоречит
интуиции и большинству гайдов.

**3. `config-interval=1` — реальный баг:** WebCodecs в annexb-режиме **требует** SPS+PPS внутри
каждого keyframe-чанка. Нужно `config-interval=-1` (§5.1).

**Плюс два свежих KDE-специфичных сюрприза:**
- **KWin 6.6.4 урезал число буферов до 3–4, а `pipewiresrc` просит 16** — это ломало пайплайны
  ровно на нашей комбинации версий; лечение — `min-buffers=2 max-buffers=4` (§1.5).
- **В Plasma 6.8 (октябрь 2026) KDE удаляет проверку прав на приватные интерфейсы KWin** — то есть
  вопрос «захват без диалога» скоро решится сам, но не тем способом, который просят гайды (§4).

---

## 1. `pipewiresrc` + NVENC: на что жалуются и что помогло

### 1.1 ✅ `cudaupload` НЕ нужен — и он медленнее

`nvh264enc` принимает **system-memory BGRx напрямую**: его sink-шаблон перечисляет четыре
альтернативы — `video/x-raw(memory:CUDAMemory)`, `(memory:D3D12Memory)`, `(memory:GLMemory)`
**и обычный `video/x-raw`** — каждая с `format: { NV12, Y444, VUYA, RGBA, RGBx, BGRA, BGRx }`
— [nvh264enc](https://gstreamer.freedesktop.org/documentation/nvcodec/nvh264enc.html).

Бенчмарк 3200×1200@60 RGBA, 100 буферов, оба варианта
— [discourse 1223](https://discourse.gstreamer.org/t/nvcudah264enc-vs-nv264enc-sinks-performance/1223):
> «So doing this conversion at once, seems to take only **a third of the time**, than doing it
> separately.» — `@tadeaustria`

И объяснение от **Seungha Yang, автора плагина nvcodec**:
> «NVENC launches CUDA kernel regardless of the input format (I guess it does linear → tiled
> conversion or similar). So, **doing it at once like `nvh264enc` might be more performant**, yes.»

Он же — почему `nvcudah264enc` вообще не берёт RGB: «the reason is because NVENC does not expose
RGB → YUV conversion related parameters, so it's not controllable».

**Важно:** `cudaupload` в своих sink-caps **не имеет `memory:DMABuf`** вообще (только `video/x-raw`,
GLMemory, D3D11Memory, CUDAMemory) — [cudaupload](https://gstreamer.freedesktop.org/documentation/nvcodec/cudaupload.html).
То есть `pipewiresrc ! video/x-raw(memory:DMABuf) ! cudaupload` **не может согласоваться by design**.

**Совет про `nvvidconv` — вредный, и его опроверг мейнтейнер.** В треде 4764 случайный участник
советовал «use nvvidconv instead of videoconvert»; Matthew Waters (мейнтейнер GStreamer):
> «`nvh264enc` is not the encoder provided by Nvidia but the upstream encoder and **does not work
> with Nvidia provided `nvvidconv` or `nvvideoconvert`**.»
> — [discourse 4764](https://discourse.gstreamer.org/t/h264-pipewire-issues/4764)

`nvvidconv`/`nvvideoconvert` — это Jetson/DeepStream, на x86-десктопе нерелевантно.
**Игнорировать любой совет, где они упоминаются.**

### 1.2 ✅ Подтверждённый рабочий пайплайн ИМЕННО на KDE Plasma

[discourse 5575](https://discourse.gstreamer.org/t/pipewiresrc-unhandled-format-error-on-hyprland-with-webrtcbin-works-on-gnome-kde/5575)
— «Our pipeline works perfectly on GNOME **and KDE Plasma**» (падает только на Hyprland):

```
pipewiresrc ! queue max-size-buffers=3 leaky=downstream
  ! videoconvert ! videoscale ! videorate
  ! video/x-raw(memory:SystemMemory),format=NV12,width=1920,height=1080,framerate=60/1
  ! nvh264enc bitrate=8000 rc-mode=cbr preset=low-latency-hq tune=ultra-low-latency \
              gop-size=60 zerolatency=true qos=false
```

Второй рабочий образец (продакшн-код, `@bluewave41`,
[discourse 5570 #8](https://discourse.gstreamer.org/t/pipewiresrc-not-using-full-framerate/5570)):
```
pipewiresrc path={node} fd={fd} ! video/x-raw,width=W,height=H
  ! queue max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream
  ! nvh264enc bitrate=25000 gop-size=30 zerolatency=true preset=low-latency-hq rc-mode=cbr
  ! rtph264pay … ! udpsink
```
и его же вариант, «works perfectly on Ubuntu 24.04»:
`pipewiresrc path={p} keepalive-time=50 ! video/x-raw,… ! queue max-size-buffers=2 leaky=downstream ! nvh265enc …`
([discourse 5812](https://discourse.gstreamer.org/t/pipeline-no-longer-works-on-ubuntu-26-04/5812)).

Ещё подтверждение из продакшн-кода (helixml, GNOME+NVIDIA):
«✅ `nvh264enc` handles BGRA→NV12 conversion **internally on GPU**»
— [helixml/helix design notes](https://github.com/helixml/helix/blob/main/design/2026-01-13-pixel-format-flow-analysis.md).

### 1.3 ⚠️ DMA-BUF: не форсировать (и на NVIDIA он всё равно тупик)

Мейнтейнер GStreamer:
> «I believe **dmabuf negotiation is slightly broken in pipewiresrc** and you may need to force it,
> we should really reimplement this in upstream gstreamer… **OBS does use DMAbuf whenever possible**
> to avoid copie[s] in the path.» — Nicolas Dufresne, [discourse 5570](https://discourse.gstreamer.org/t/pipewiresrc-not-using-full-framerate/5570)

Попытка форсировать провалилась (тот же тред):
```
pipewiresrc path=56 ! video/x-raw(memory:DMABuf) ! queue ! …
ERROR: No supported formats found
gst_pipewire_src_negotiate (): This element does not have formats in common with the peer
streaming stopped, reason not-negotiated (-4)
```

А в другом треде тот же мейнтейнер показывает **обратное** — DMABuf согласуется сам, а форсирование
system memory ломает:
> «Its actually **the other way around**. If I replaced xvimagesink with glimagesink, it works…
> **If I force non-dmabuf negotiation, we are back to the issue** we had.»
> — [discourse 3987](https://discourse.gstreamer.org/t/gstreamer-pipewiresrc-cant-capture-full-screen/3987)

**Разрешение противоречия — в исходниках `pipewiresrc`:** `handle_format_change()` ставит
`buffertypes = (1 << SPA_DATA_DmaBuf)` **безусловно** и добавляет MemFd/MemPtr только если у формата
продюсера **нет** `SPA_FORMAT_VIDEO_modifier`. На NVIDIA+KWin модификаторы предлагаются всегда →
`pipewiresrc` просит **только DMABuf, без SHM-фоллбэка**
— [gstpipewiresrc.c](https://gitlab.freedesktop.org/pipewire/pipewire/-/blob/master/src/gst/gstpipewiresrc.c).
Патч «Only request DMABUF buffers if the negotiated caps support DMABUF» —
[PipeWire#4888](https://gitlab.freedesktop.org/pipewire/pipewire/-/issues/4888), **открыт**:
«gets rid of the `EGL_BAD_ALLOC` errors, but the buffer recycling still continues to fail and I get
very choppy video».

**И главный NVIDIA-специфичный стопор:** портал отдаёт **block-linear (tiled) модификаторы**:
«the DRM modifier is something like `0x030000000060601x` … which is nvidia's block linear drm format»
— [discourse 5482](https://discourse.gstreamer.org/t/dma-buf-with-nvidia-card/5482).
helixml подтверждает и добавляет жёсткое ограничение:
> «✅ NVIDIA modifiers (`0xe08xxx` family) are required for CUDA import» … «**NVIDIA doesn't support
> standard `DRM_IOCTL_PRIME_FD_TO_HANDLE` for DMA-BUF import. You MUST go through EGL.**»
> — [helixml zero-copy notes](https://github.com/helixml/helix/blob/main/design/2026-01-10-zero-copy-video-streaming.md)

**`glupload` на проприетарной NVIDIA тоже не завёлся** у нескольких людей: `Failed to bind context
to the current rendering thread: EGL_SUCCESS` → «no caps can be handled by this pad» → `-4`
(discourse 3987 #18/#20, 5482). Автор Wolf (Games-on-Whales) описал ту же стену:
> «On Nvidia it seems that **the only way to pass a DMA buffer is to go through `glupload`** so that
> it turns that out into `GLMemory` that can then be fed into nvenc… when I dispose of one Gstreamer
> pipeline it's messing something up with OpenGL that ends up **crashing all the other running
> Wayland compositors**.» — [discourse 4856](https://discourse.gstreamer.org/t/zero-copy-pipeline-on-nvidia/4856)

**Вывод: настоящий zero-copy на NVIDIA доступен только через кастомный код**
(DMABuf → EGLImage → `cuGraphicsEGLRegisterImage` → CUDAMemory), как в helixml/Wolf, а не через
стоковые элементы GStreamer.

### 1.4 `always-copy` — нюанс, а не «убрать»

В `gstpipewiresrc.c` свойство помечено `G_PARAM_DEPRECATED` и работает как алиас:
`always-copy=true` ⇒ `use-bufferpool=NO`, `false` ⇒ `YES`; дефолт `AUTO`. В пути dequeue:
`use_bufferpool != NO → gst_memory_share()`, иначе `gst_memory_copy()`.
(`use-bufferpool` — булев для трёхзначного состояния, известная кривизна:
[PipeWire#5257](https://gitlab.freedesktop.org/pipewire/pipewire/-/issues/5257).)

И совет мейнтейнера прямо оправдывает копию:
> «make sure pipewire frames are **transformed or copied ASAP**, **doing zero copy with it often
> results in starvation** (you cannot alloted more buffer, it's pipewire that decides)»
> — Dufresne, [discourse 5570](https://discourse.gstreamer.org/t/pipewiresrc-not-using-full-framerate/5570)

Продакшн-код выбирает значение **по типу памяти энкодера**
([project-monitorize](https://github.com/vinnavannewton/project-monitorize/blob/main/linux/monitorize/streaming/pipeline_builder.py)):
```python
zero_copy = hw_encoder != "nvh264enc" or nvidia_memory == "gl"
always_copy = "false" if hw_encoder and zero_copy else "true"
```
т.е. **`always-copy=true` для system/cuda-путей NVENC** и `false` только для `glupload`-пути.

**Значит наш `always-copy=true` для system-memory пути — верен.** Менять его без надобности не надо;
современное написание — `use-bufferpool=false`.

### 1.5 🔴 СВЕЖЕЕ и KDE-специфичное: KWin урезал число буферов

[discourse 5806 «KWin 6.6.4 + PipeWire 1.6.2 broke GStreamer 1.28.2»](https://discourse.gstreamer.org/t/kwin-6-6-4-pipewire-1-6-2-broke-gstreamer-1-28-2/5806):
> «Issue founded. **Kwin changed the maximum buffer size from 1 to 16 to 1 to 4.** …
> **adjusting the buffer size on my gstreamer pipeline fixed my issue.**»

Причина — KWin MR !5502: «plugins/screencast: Prefer allocating 3 buffers per stream by default —
The current default 16 is way too many. For example, when screencasting a 4K output, about 500MB
will be wasted.» А `pipewiresrc` просит `CLAMP(16, min_buffers, max_buffers)`, т.е. **16**.

**Лечение: `min-buffers=2 max-buffers=4`.** Это ровно наша комбинация версий
(у нас GStreamer 1.28.4, libpipewire 1.6.6, Plasma 6.x) — то есть риск актуальный, а не исторический.

### 1.6 Что реально отдаёт портал KDE

Таблица форматов из исходников KWin (`src/plugins/screencast/screencaststream.cpp`):
`DRM_FORMAT_ARGB8888 → BGRA`, `DRM_FORMAT_XRGB8888 → BGRx`, плюс RGBA/RGBx/ABGR/xBGR/ARGB/xRGB,
`NV12`, и 24-битные `RGB888/BGR888`. На практике — **BGRx или BGRA**:
- `video/x-raw, format=(string)BGRx, width=2560, height=1440, framerate=0/1, max-framerate=…`
  ([discourse 4764](https://discourse.gstreamer.org/t/h264-pipewire-issues/4764));
- Arun Raghavan (мейнтейнер PipeWire): `format=(string)BGRx, width=3840, height=2160, framerate=0/1`
  (discourse 3987 #21);
- KDE через OBS: `Format: 12 (Spa:Enum:VideoFormat:BGRA)`, `Modifier: 0` **и**
  `216172782128496660` (= `0x0300000000E06014`, NVIDIA block-linear)
  ([forum.manjaro.org](https://forum.manjaro.org/t/screen-recording-on-kwin-wayland/136669)).

**Как KWin выбирает DMABuf vs MemFd** (исходник): `buffertypes = m_dmabufParams ? DmaBuf : MemFd` —
**строго одно из двух**, и решает это список модификаторов, который предложил клиент. Т.е. на KDE
получим мы tiled DMABuf или обычный MemFd, зависит от того, что рекламирует наш downstream.

### 1.7 Каталог `not-negotiated (-4)`: причина → лечение

| Симптом | Причина | Лечение / статус |
| --- | --- | --- |
| `pipewiresrc ! videoconvert ! nvh264enc` висит 15 с в PAUSED, потом `-4`; caps были BGRx | Смешали самосборный `libgstnvcodec.so` с дистрибутивным GStreamer (nvcodec отсутствует в `gstreamer1.0-plugins-bad` Ubuntu 25). **Та же команда работает на PopOS и Ubuntu 24.04** | Использовать дистрибутивный nvcodec, не мешать cerbero/самосбор ([4764](https://discourse.gstreamer.org/t/h264-pipewire-issues/4764)) |
| `! video/x-raw(memory:DMABuf) !` → `No supported formats found` | pipewiresrc не фиксирует DMA_DRM; downstream не импортирует tiled-модификаторы NVIDIA | **Не форсировать DMABuf** (§1.3) |
| `glupload`/`glcolorconvert` → `EGL_SUCCESS` → `-4` | GL-контекст не создаётся под проприетарной NVIDIA + Wayland | Не решено; `vapostproc` — только AMD/Intel |
| `pipewiresrc ! fakesink` → `-4`, в логе `connect error` | Сбой на стороне PipeWire, не caps | Sebastian Dröge: «this looks like a pipewire problem one way or another» ([PipeWire#4765](https://gitlab.freedesktop.org/pipewire/pipewire/-/issues/4765), закрыт) |
| `stream error: unhandled format` | Компositor отдаёт формат, который pipewiresrc не умеет. Пайплайн с **nvh264enc** «works perfectly on GNOME and KDE Plasma», падает на **Hyprland** | Дröge: «pipewiresrc … does not support whatever format is provided by hyprland» ([5575](https://discourse.gstreamer.org/t/pipewiresrc-unhandled-format-error-on-hyprland-with-webrtcbin-works-on-gnome-kde/5575)) |
| `cudaconvertscale … could not transform … BGRA … ` → `-4` | GStreamer в контейнере не слинковал CUDA-символы, у `cudaconvertscale` нет рабочего BGRA→NV12 ядра | [wolf#350](https://github.com/games-on-whales/wolf/issues/350) — «fixed with recent merges». Урок: битые CUDA-ядра дают ровно этот `-4` на валидных caps |
| `-4` / фриз при renegotiation (изменение виртуального монитора) | Компositor пересогласовывает узел, GStreamer не обрабатывает | Открыт: [gstreamer#5099](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/5099). Обход: «poll for monitor changes and restart all sender processes» |
| keepalive-буфер → `-4` после закрытия потока, **если есть crop-элемент** | pipewiresrc досылает keepalive после конца стрима | **Открыт**, Arch, PipeWire 1.6.7 / GStreamer 1.28.4 — **наши версии**. Обход: «Recording without a crop element … works correctly» ([PipeWire#5326](https://gitlab.freedesktop.org/pipewire/pipewire/-/issues/5326)) |

### 1.8 Выбор энкодера

| | `nvh264enc` | `nvcudah264enc` | `nvautogpuh264enc` |
| --- | --- | --- | --- |
| Rank | **primary + 1** (автоподбор) | primary-ish | **none** (называть явно) |
| Sink caps | `video/x-raw` + CUDA/D3D12/GL, `{NV12,Y444,VUYA,RGBA,RGBx,BGRA,BGRx}` | **только YUV** — нужен `cudaconvert` | как у `nvh264enc` |
| RGB на входе | ✅ конвертирует **внутри NVENC** | ❌ | ✅ |
| `memory:DMABuf` | ❌ | ❌ | ❌ |

Все найденные рабочие пайплайны с `pipewiresrc` используют `nvh264enc`/`nvh265enc`; **ни одного
сообщества-отчёта об использовании `nvautogpuh264enc` с `pipewiresrc` не найдено**. Для одиночного
GPU практического выигрыша нет (он про multi-GPU / выбор origin буфера).

### 1.9 Прочие грабли того же класса

- **`videorate` ломает `pipewiresrc`** — «videorate break pipewiresrc, you can workaround with
  `drop-only` property, or moving the rate adjustement **after** pipewire buffer has been copied»
  (Dufresne, discourse 3987 #19); также [PipeWire#1793](https://gitlab.freedesktop.org/pipewire/pipewire/-/issues/1793).
- **Иногда нужно снять `do-timestamp`** — у человека фриз после первого кадра лечился апгрейдом
  PipeWire 1.0.5→1.4.8 **плюс** «I had to remove `do-timestamp` in order for it to work»
  ([discourse 5426](https://discourse.gstreamer.org/t/send-screencapture-data-from-pipewire-to-webrtc/5426)).
- **Fullscreen-приложения убивают захват** — Dufresne воспроизвёл и заключил: «That looks like a
  **compositor bug**… Since it's all happening inside the compositor, and it's not NVidia specific,
  I don't think you can do anything in GStreamer» (3987). На KDE соответствующий баг
  [#495287](https://bugs.kde.org/show_bug.cgi?id=495287) **RESOLVED FIXED в Plasma 6.3**, с внятным
  механизмом: «If `endFrame` never gets called though (for example because we're doing **direct
  scanout**) then the release points never get signaled, and the client very quickly runs out of
  buffers to use and freezes». Обход, если всплывёт: `KWIN_DRM_NO_DIRECT_SCANOUT=1`.
- **Исторический KDE+NVIDIA чёрный экран** через портал+`pipewiresrc`:
  [bugs.kde.org #476602](https://bugs.kde.org/show_bug.cgi?id=476602) — FIXED в **Plasma 5.27.10**,
  «Also simultaneously fixed in an upcoming nvidia driver bugfix release» / «fixed in the 545 nvidia
  driver too». Plasma **6.6.3** отдельно принёс «KWin screencasting more robust when using PipeWire
  1.6 or newer».
- **Версия драйвера раньше решала многое:** человек с RTX 4090 «solved by upgrading NVIDIA drivers
  to version 555» ([discourse 2413](https://discourse.gstreamer.org/t/pipewiresrc-ui-starving-for-resources/2413)).
  Мы на 610.x — все известные плохие версии позади.
- **Живой NVIDIA-баг Plasma 6:** пустое видео, в логах `pipewire: invalid memory type 8` и
  `kwin_wayland: … Received stream buffer that does not contain user data`; не решён на февраль 2026
  ([Arch BBS 311497](https://bbs.archlinux.org/viewtopic.php?id=311497)).
- **`pipewiresrc` нужно давать И `path=`, И `fd=`**, иначе он молча цепляется к веб-камере
  ([r/gstreamer](https://www.reddit.com/r/gstreamer/comments/1kmegs9/recording_screen_using_gstreamer_pipewire/)).

### Насколько это применимо к нам

**Целевой пайплайн, который поддерживается доказательствами:**
```
pipewiresrc fd=<fd> path=<node> keepalive-time=34 min-buffers=2 max-buffers=4 always-copy=true
  ! video/x-raw,width=W,height=H            # система; НИКАКОГО memory:DMABuf
  ! queue max-size-buffers=2 max-size-time=0 max-size-bytes=0 leaky=downstream
  ! nvh264enc bitrate=8000 rc-mode=cbr preset=low-latency-hq tune=ultra-low-latency \
              zerolatency=true gop-size=60 aud=true repeat-sequence-header=true qos=false
  ! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream,alignment=au ! fdsink fd=1
```
- **Без `cudaupload`, без `videoconvert`, без `nvvidconv`** — `nvh264enc` берёт BGRx и конвертирует
  на GPU быстрее (§1.1).
- Если откажется согласовываться — добавить `videoconvert ! video/x-raw,format=NV12` (форма,
  подтверждённая на KDE в 5575), и только потом трогать что-либо DMABuf-образное.
- **`videoscale` убрать из горячего пути**, если можно: масштабирование лучше делать выбором
  разрешения виртуального выхода (§4) или на GPU.
- **Первым делом на стенде:** `gst-inspect-1.0 nvcodec` должен показать ~21 features. `0 features` +
  `CUDA library "libcuda.so.1" was not found` = NVENC нет. Это не теория: у человека на Plasma 6.6
  Wayland в логах было `Attempting to use NVENC without CUDA support. Reverting back to
  GPU -> RAM -> GPU`, и установка CUDA дала **15 мс → 4 мс** кодирования
  ([r/MoonlightStreaming](https://www.reddit.com/r/MoonlightStreaming/comments/1sb8104/poor_encoding_latency_with_apollo_on_linux_using/)).
  Самая дешёвая крупная победа в списке.
- **Настоящий zero-copy не планировать** — на NVIDIA он требует своего EGL-кода (§1.3).

---

## 2. Просадки кадров и задержка: причины и что помогает

### 2.1 ✅ `keepalive-time` — единственный «problem solved» ровно про наш симптом

Проблема сформулирована буквально как наша:
> «I'm using the framerate cap but I noticed that **when there is nothing moving on the screen during
> the screen capture, the framerate goes down.** I tried using videorate cap but it doesn't work well…»
> → на следующий день: «**setting a lower keepalive value solved my issue. problem solved.**»
> — [discourse 4959](https://discourse.gstreamer.org/t/pipewiresrc-how-to-set-a-fixed-framerate/4959)

`keepalive-time` — в **миллисекундах**, заставляет `pipewiresrc` **перевыслать последний буфер**,
если нового не пришло (дефолт `0` = выключено). Значения из практики: `50` (bluewave41), `1000`.
Для 30 к/с логично `34`, для 60 к/с — `17`. Вторая половина механизма — `resend-last=true`.
Корневая причина (damage-based capture) — [gstreamer#3581](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/issues/3581).

Насколько это важно, видно из [bugs.kde.org #476186 (комм. 8)](https://bugs.kde.org/show_bug.cgi?id=476186):
> «there are only 90 actual frames in the file, because **KPipeWire seems to be dropping duplicate
> frames** rather than sending them to the encoder. In a 15.35 second clip with a nominal framerate
> of 60 fps, you expect to see 921 frames. So ffmpeg has only encoded **1 in 10 frames**.»

И подтверждение, что KWin честно объявляет переменную частоту — лог Sunshine:
`Requested frame rate [60/1, approx. 60 fps]` … `Framerate (from compositor): 0/1 (variable rate capture)`
— [Sunshine#4884](https://github.com/LizardByte/Sunshine/issues/4884).

### 2.2 ✅ `queue` сразу за `pipewiresrc`

> «Pipewiresrc comes with some quirks, I believe it does limited allocations, and **has no tolerance
> to delivery delays.** My very first suggestion would be to **add a ‘queue’ element right after
> pipewiresrc.** … My second recommendation would … to **disable the last sample feature** on the
> videosink…» — Dufresne, [discourse 5570](https://discourse.gstreamer.org/t/pipewiresrc-not-using-full-framerate/5570)

Практика по `queue`:
- Глубина **2**, а не 1 (`luis.merayo`, [discourse 5693](https://discourse.gstreamer.org/t/pipeline-latency-tuning/5693)).
- Задавать **все три** лимита, иначе остаются дефолты 200 буферов / 10 МБ / 1 с.
- `leaky` — только на источнике: «Using leaky queues should be done … **only in the source
  pipeline**» ([Hailo](https://community.hailo.ai/t/quick-tip-gstreamer-queues/151)).
- `leaky` может сделать **хуже**: «does seem to drop frames as desired, but **it significantly slows
  down the pipeline**» ([discourse 971](https://discourse.gstreamer.org/t/max-buffers-ignored-in-gstreamer-pipeline-with-ip-cameras-on-raspberry-pi/971));
  и он ломает расчёт латентности базовых классов
  ([GStreamer latency design](https://gstreamer.freedesktop.org/documentation/additional/design/latency.html)).
- У нас sink — `fdsink`; аналог совета «не держать последний сэмпл» — `enable-last-sample=false`
  (свойство GstBaseSink, есть и у `fdsink`/`appsink`), плюс `sync=false`.

### 2.3 CPU-конвертация: измеренная цена

`xvimagesink` «relies on the CPU for color-space conversion»; на 7560×1920@60 CPU не успевал, замена
на `glimagesink` вернула 60 fps — [endpointdev](https://www.endpointdev.com/blog/2026/05/solving-hi-res-video-stutter-gstreamer-hardware/).
В проекте, похожем на наш: «`h264_nvenc` (GPU) … **CPU usage increases (~50-85%) due to required
CPU-side BGR→YUV444p conversion before GPU upload**» — [LLrdc](https://github.com/danchitnis/LLrdc).
Механизм, которого надо избегать, словами мейнтейнера GPU Screen Recorder:
«OBS only uses the gpu for video encoding, but the window image that is encoded is **copied from the
GPU to the CPU and then back to the GPU**… These operations are very slow»
— [dec05eba](https://git.dec05eba.com/gpu-screen-recorder/about).

### 2.4 Квант графа PipeWire может структурно ограничить fps

На wlroots это доказано и починено: дефолтный квант `1024/48000` (аудио-квант, ≈47 Гц):
> «the driver assigned by Pipewire for xdpw is **driving the graph at an incorrect rate, `1024/48000`
> by default, which translates to about 40 fps** … By specifying `PW_KEY_NODE_MAX_LATENCY`…»
> — [xdg-desktop-portal-wlr#351](https://github.com/emersion/xdg-desktop-portal-wlr/issues/351) →
> [PR#370](https://github.com/emersion/xdg-desktop-portal-wlr/pull/370); ревьюер измерил «~23fps → ~46.8fps»

Проверяется через `pw-top`.

### 2.5 Баги KWin про частоту/заикание захвата — со статусами

| Баг | Суть | Статус |
| --- | --- | --- |
| [#469777](https://bugs.kde.org/show_bug.cgi?id=469777) | KWin с 5.27.5 жрёт ядро на 100% при любом PipeWire-захвате | **Исправлен** (5.27.11). Причина — сам код троттлинга: коммит «screencast: Ensure we respect the negotiated framerate» — «**Discards frames sent under the timeframe that was negotiated with the client.**» Репортёр: `Dropping a screencast frame because the compositor is slow` выросло «**from like 20 per second to well over 1000 per second**» |
| [#495287](https://bugs.kde.org/show_bug.cgi?id=495287) | PipeWire-захват **замораживает fullscreen-приложения** | **FIXED, Plasma 6.3** (explicit sync + direct scanout, §1.9) |
| [#520443](https://bugs.kde.org/show_bug.cgi?id=520443) | Screencast через KWin даёт frametime-заикание в играх **ещё до начала записи** | **ОТКРЫТ** (2026-05→07). KWin 6.6.5, **AMD RX 9070 XT** — т.е. **не NVIDIA-only**. «Because multiple independent applications reproduce the same behavior, this does not appear to be application-specific… **the issue is specific to KWin's desktop screencast implementation.**» При этом «Using vkCapture … **does not introduce any frametime stutter**» |
| [#522041](https://bugs.kde.org/show_bug.cgi?id=522041) | Screencast 4K@240 → тяжёлая нагрузка CPU (регрессия 6.7, NVIDIA) | REPORTED, 0 комментариев — не подтверждён |
| [#514179](https://bugs.kde.org/show_bug.cgi?id=514179) | Мерцание окон в записях OBS | CONFIRMED. Отдельно ценно: `KWIN_TRIPLE_BUFFER=1` — «That KWin environment variable **doesn't actually exist**» (Zamundaaa) |

**Позиция KDE по триажу** (Zamundaaa, [discuss.kde.org 13593](https://discuss.kde.org/t/stutter-when-trying-to-record-the-screen-pipewire-wayland/13593)):
«If you can also reproduce the stutter in a different app, then please make a bug report … for KWin.
If not, then make it for obs».
**Диагностика, которую просит KDE:** `KWIN_LOG_PERFORMANCE_DATA=1` → CSV по каждому дисплею в `$HOME`.

### 2.6 Кто ушёл с `pipewiresrc` и на что

| Куда | Кто / где | Результат |
| --- | --- | --- |
| **GPU Screen Recorder** (`-w DP-1`, минуя портал) | `Schlaefer`, [discuss.kde.org 13593](https://discuss.kde.org/t/stutter-when-trying-to-record-the-screen-pipewire-wayland/13593) | «that option **works**. But **as soon that uses pipewire-portal the stutters are back**» |
| GPU Screen Recorder | [sway#9177](https://github.com/swaywm/sway/issues/9177), [mutter#4214](https://gitlab.gnome.org/GNOME/mutter/-/issues/4214) | «**bypasses pipewire stack**» |
| **obs-vkcapture** | [NVIDIA devforum 278807](https://forums.developer.nvidia.com/t/choopy-desktop-capture-using-pipewire-and-obs-studio-30-0-2-on-wayland/278807), kde#520443 | «The only way to bypass this issue» |
| **wlrobs / obs-wlroots-screencopy** | OBS forum 172753 | работает — **но протокол wlroots-only, на KWin невозможен** (§4) |
| **`gst-wayland-display`** (games-on-whales): микро-компositor Wayland **как плагин GStreamer**, отдаёт DMABuf / VAMemory / **CUDAMemory** | [github](https://github.com/games-on-whales/gst-wayland-display) | Ближайший к нам аварийный выход: «supports outputting **CUDA buffers for low-latency Nvidia pipelines**. By not using `glupload` and `glcolorconvert` we can not only be way more efficient…» |

Мейнтейнер GSR документирует портальную проблему прямо: «**Their desktop portals send frame updates
at low framerates (such as 25 fps) instead of the selected framerate (such as 60 fps).** Capture a
monitor directly instead» + опция `-fm content` — [git.dec05eba.com](https://git.dec05eba.com/gpu-screen-recorder/about).

### 2.7 Задокументированные ТУПИКИ

| Попытка | Источник | Итог |
| --- | --- | --- |
| `__GL_YIELD=USLEEP` | NVIDIA devforum 278807 | «**it did not helped**» |
| `enable-last-sample=false` без `queue` | discourse 5570 | ~40 fps; Dufresne: «**You missed the queue part of my comment**» |
| Принудительный `video/x-raw(memory:DMABuf)` | discourse 5570 | `No supported formats found` |
| `glimagesink` / `vapostproc` / `glupload…gldownload` | discourse 5570, 3987 | «neither glimagesink nor vapostproc work with it»; EGL-ошибки |
| Запись на 30/48/60 fps | OBS forum 172753 | «it didn't» |
| `pw-metadata … clock.force-quantum 256` для видео | [Fedora 85982](https://discussion.fedoraproject.org/t/pipewire-audio-video-latency/85982) | не помогло |

### Насколько это применимо к нам

Приоритеты (по силе доказательств): **(1)** `keepalive-time=34` + `resend-last=true`;
**(2)** `queue max-size-buffers=2 …` сразу за `pipewiresrc`; **(3)** `min-buffers=2 max-buffers=4`
(§1.5); **(4)** уйти на `nvh264enc` без CPU-конвертации (§1.1); **(5)** проверить квант (`pw-top`);
**(6)** `config-interval=-1` (§5); **(7)** `fdsink sync=false enable-last-sample=false`.

**Диагностический разделитель, который надо прогнать ПЕРЕД оптимизацией:** снять то же содержимое
GPU Screen Recorder'ом **напрямую (`-w DP-1`) и через портал (`-w portal`)**. Если напрямую ровно, а
через портал рвётся — наш GStreamer ни при чём (баг KDE #520443 открыт). Кто дропает, различимо:
`journalctl --user -g "Dropping a screencast frame"` (KWin) против `GST_DEBUG=pipewiresrc:5` +
счётчик кадров (GStreamer).

> **Честная калибровка:** подтверждённого рецепта «`pipewiresrc` → стабильные 60 fps на KWin
> Plasma 6», проверенного счётчиком кадров, в сообществе НЕТ. Все треды кончаются обходом
> (`keepalive`, апгрейд PipeWire, буферы) либо уходом на GSR/vkcapture. Наши 30 к/с — разумная цель.

---

## 3. Постоянство согласия портала: `restore_token` / `persist_mode`

> Этот раздел проверен не только по обсуждениям, но и **по исходникам** xdg-desktop-portal,
> xdg-desktop-portal-kde и flatpak-kcm, плюс живой интроспекцией портала.
> Версии на машине владельца: **xdg-desktop-portal 1.22.0, xdg-desktop-portal-kde 6.6.5,
> интерфейс `ScreenCast` версии 4, `RemoteDesktop` версии 2**; таблицы permission store
> `screencast` / `remote-desktop` / `kde-authorized` — **пустые** (персистентная сессия ещё не
> выдавалась ни разу).

### 3.1 Как это устроено (важно для всего остального)

- Таблица — `screencast` в permission store; файл — `$XDG_DATA_HOME/flatpak/db/screencast`
  (имя «flatpak» историческое, flatpak тут не участвует). Демон — отдельный долгоживущий
  `/usr/lib/xdg-permission-store`.
- **`restore_token` — это идентификатор ресурса в permission store**, а app-id лежит *внутри*
  записи (`xdp-session-persistence.c`).
- **Цикл «съел → перезаписал»** — комментарий в коде дословно:
  «*Lookup permissions in memory first, and fallback to the permission store if not found.
  **Immediately delete them now as a safety measure**, since they'll be stored again when the
  session is closed.*» То есть запись **удаляется на `SelectSources`** и создаётся заново в `Start`
  и при закрытии сессии.

**Отсюда сразу разрешается противоречие спеки и наблюдений.** Спека говорит «The restore token is
invalidated after using it once… use the **new** restore token»; при этом Prajna Sariputra наблюдал:
«both the GNOME and KDE portals appear to **just use the same token anyway**»
([#480235](https://bugs.kde.org/show_bug.cgi?id=480235)). В коде: новый токен генерируется **только
если приложение не прислало свой** (`if (!*in_out_restore_token) *in_out_restore_token = xdp_generate_token();`).
Одноразовой является **запись**, а не строка. Практическое правило не меняется: **всегда перезаписывать
свой токен тем, что вернул `Start`.**

### 3.2 Работает ли `persist_mode=2` на xdp-kde и с каких версий

Работает, для ScreenCast — **с Plasma 5.25**, но история из нескольких «теперь-то работает»:

| Что | Версия | Источник |
| --- | --- | --- |
| Jan Grulich: у KDE восстановления **нет** | 2022-02 | [jgrulich.cz](https://jgrulich.cz/2022/02/16/webrtc-journey-to-make-wayland-screen-sharing-enabled-by-default) |
| ScreenCast restore реализован | **5.25** | [#445875](https://bugs.kde.org/show_bug.cgi?id=445875), MR !79 (Aleix Pol, 04.04.2022) |
| Восстанавливалось **только один раз**, потом снова диалог | fixed **5.25** | [#454128](https://bugs.kde.org/show_bug.cgi?id=454128), коммит Aleix Pol «screencast: Keep persisting if the user chose to persist» |
| Восстановление **окна** сломалось и починено | **6.1.0** | [#486387](https://bugs.kde.org/show_bug.cgi?id=486387); Nate Graham: «This is fixed in Plasma 6.1» |
| **RemoteDesktop** persistence через перезагрузку | **6.1.1** | [#480235](https://bugs.kde.org/show_bug.cgi?id=480235) — см. §3.5 |
| Восстановление зеркалированных экранов | 2026-06 | [#470460](https://bugs.kde.org/show_bug.cgi?id=470460), David Redondo: «This works now in my testing» |

Приёмочный тест самого Jan Grulich на MR !79: «I tested it with OBS and it seems to work, **I was
able to share a screen again without getting prompted** to pick a screen».

Самое сильное «оно работает» от KDE — Nicolas Fella, закрывая
[#492251](https://bugs.kde.org/show_bug.cgi?id=492251) как DOWNSTREAM:
> «This is a bug in RustDesk, **it doesn't request the stream to be remembered** (it does not pass a
> `persist_mode` to the portal request…). **It works as expected with e.g. OBS Studio**»

Это доминирующий сценарий в этом баг-пространстве: пользователь жалуется «спрашивает каждый раз»,
а разработчик KDE находит, что **приложение** не передало `persist_mode` либо не сохранило новый токен.

`persist_mode=1` (transient) при этом объективно ненадёжен: он живёт в памяти по ключу
`"sender/token"` и умирает на `peer-disconnect`; плюс в xdp 1.18 он отдельно ломался
([#1124](https://github.com/flatpak/xdg-desktop-portal/issues/1124): «**It works if the persist mode
is until explicitly revoked**»). И запрошенный режим — это **потолок, а не гарантия**:
бэкенд применяет `MIN(запрошенный, свой)`.

### 3.3 🔴 TOKEN LOST WHEN — список с источником на каждый пункт

1. **Диалог отменён или `Start` упал ПОСЛЕ `SelectSources`** — запись уже удалена, а сохранить её
   некому. *(вывод из кода `xdp-session-persistence.c`, живьём не воспроизводилось)*
2. **Пользователь снял галочку согласия.** `screencast.cpp:282` вставляет `persist_mode`/`restore_data`
   только `if (allowRestore)`. В сочетании с п.1 **одно снятие галочки убивает сохранённую сессию
   безвозвратно.** Галочка предустановлена (`ScreenChooserDialog.qml`, `checked: true`, «Allow the
   application to do this without asking next time») — по умолчанию включена с 02.04.2022.
3. **`persist_mode=1` вместо 2** (см. §3.2).
4. **Бэкенд понизил режим** — `MIN(...)`.
5. **🔴 Записанный монитор больше не находится на прежней позиции.** KDE идентифицирует выходы
   **по координатам, а не по EDID/коннектору**: `outputsmodel.cpp:158` →
   `const QString uniqueId = QStringLiteral("%1x%2").arg(pos.x()).arg(pos.y());`, а восстановление
   требует `selectedOutputs.count() == restoreOutputs.count()`.
   **И у этого есть признанное разработчиками следствие по безопасности.** Jan Grulich (MR !79):
   «when I shuffle with screens in systemsettings, e.g. move screen on the left to the right and vice
   versa, while sharing one of those screens, **it will share a content of a screen I didn't pick to
   be shared**»; Aleix Pol: «Right, we are identifying them by their position… **I think going by
   position is our best bet here.**» То есть **перестановка мониторов не инвалидирует токен, а тихо
   восстанавливает НЕ ТОТ экран**.
6. **Смена разрешения, сдвинувшая origin другого монитора** — тот же механизм. *(вывод из кода)*
7. **Записанное окно закрыто или сильно сменило заголовок** — `tryMatchWindows()` требует точного
   равенства `appId` и расстояния Левенштейна по заголовку `< title.size()/2`.
8. **Регион больше не влезает в workspace** — `fullWorkspace.contains(selectedRegion)`.
9. **🔴 Смена бэкенда/DE.** KDE пишет тег `"KDE"` и проверяет `restoreData.session == "KDE"`;
   GNOME — `"GNOME"`. Чужой токен **молча игнорируется**. **Это живой риск на этой машине:** у
   владельца стоит Ambxst/Hyprland рядом с KDE, а `hyprland-portals.conf` задаёт
   `default=hyprland;gtk` против `kde-portals.conf` `default=kde`. Сессия в Hyprland убьёт
   KDE-токен и наоборот.
10. **Будущая смена формата restore-data** (в flatpak-kcm есть комментарий ровно про это).
11. **App-id при выдаче и при восстановлении различаются** — поиск строго точный. Подтверждено
    полевым наблюдением Prajna Sariputra ([#480235](https://bugs.kde.org/show_bug.cgi?id=480235) #16):
    > «for persistence to work correctly you'll want to make sure **it's started the same way every
    > time**, in the past I've noticed that **opening it using Kickoff/KRunner, via autostart or
    > manually running it in a terminal window can result in the portal thinking it's a different
    > app and rejecting persistence**.»
12. **Приложение не перезаписало токен из ответа `Start`** — ровно подпись
    [xdp-hyprland#123](https://github.com/hyprwm/xdg-desktop-portal-hyprland/issues/123):
    «in OBS, it works, but **only for the next run**. 2 runs later and the window picker is back».
13. **Приложение потеряло свой файл с токеном** — токен хранится на стороне приложения
    (`~/.local/share/krfb/krfbstaterc`, `~/.config/rustdesk/RustDesk_local.toml`, KWallet…).
    Отсюда же лечение «залипшего» токена: удалить файл, чтобы приложение запросило новый
    ([#480235](https://bugs.kde.org/show_bug.cgi?id=480235) #18: «**Deleting those files did the trick!**»).
14. **Явный отзыв** — System Settings → Application Permissions, или
    `flatpak permission-remove screencast <token>`.

**НЕ теряется** от перезагрузки, логаута или рестарта `xdg-desktop-portal`: permission store — это
отдельный долгоживущий процесс, а KDE-бэкенд держит `m_restoreData` только в памяти.

**Побочный эффект, о котором стоит знать:** каждое согласие создаёт **новую** запись. flatpak-kcm
MR !169 («Add button to revoke all sessions»): «I noticed my OBS had accumulated **over 100
screencast session permissions**… it seems like **each time I do that, a new permission is created**».
Не исправлено; добавили только кнопку «отозвать всё».

### 3.4 🔑 Пустой app-id — и как его починить по-настоящему

Механизм: `xdp-app-info-host.c` → `get_app_from_pid()` вызывает `sd_pid_get_user_unit()` и **сдаётся,
если юнит не начинается с `app-`** (комментарий в коде прямо называет наш случай: «the unit might not
be started by the desktop environment (e.g. it's a script run from terminal)»), плюс требует
существующего `.desktop`. Иначе — `app_id = ""`.

Jan Grulich: «There is also an **empty entry** with “yes” stored. The empty entry is usually for
applications for which we were unable to get an application id. This happens for **host applications
that are launched in an unusual way, such as the Alt + F2 command or from a terminal**»
— [jgrulich.cz](https://jgrulich.cz/2024/12/13/when-your-webcam-doesnt-work-solving-firefox-and-pipewire-issues).

Само по себе восстановление это не ломает (`"" == ""`), но цена реальная: **нет изоляции** (любой
другой не-песочный процесс с пустым id может восстановить нашу сессию) и **сессия не видна в
System Settings** (KCM строится по `.desktop`-файлам через `KApplicationTrader`, host-app ключ —
`desktopEntryName()`; нет `.desktop` → нет строки в GUI, только CLI/D-Bus).

**Правильное решение — `org.freedesktop.host.portal.Registry.Register`** (появилось в xdp 1.19.4 /
стабильно 1.20.0). **Проверено, что на машине владельца оно есть**: bus `org.freedesktop.portal.Desktop`,
путь `/org/freedesktop/portal/desktop`, `Register(in s app_id, in a{sv} options)`, version 1.
Контракт: app-id «must be able to match the basename of a .desktop file»; «Registering can only [be]
done at most once»; «**Registering must be done before any portal method call**»; и «Applications
should ideally listen for name appeared D-Bus signalling to re-register the peer if the portal
service is restarted». Без соответствующего `.desktop` падает с `App info not found for '<id>'`.

**Альтернатива без кода:** назвать systemd-юнит `app-<AppID>.service` **плюс** положить
соответствующий `.desktop`. Так это и задумано — Harald Sitter в коммите мега-авторизации: «For host
applications it gets obtained from the systemd unit name… the https://systemd.io/DESKTOP_ENVIRONMENTS/
spec should be followed (i.e. name the unit `app-org.kde.appname.service`)».

**Инспекция и сброс:**
```bash
flatpak permission-list screencast                    # все сохранённые сессии
flatpak permission-show ""                            # всё под ПУСТЫМ app-id
flatpak permission-remove screencast <RESTORE_TOKEN>   # отозвать одну сессию
strings ~/.local/share/flatpak/db/screencast           # файл появляется после 1-го согласия
```
⚠️ **Не** делать `flatpak permission-reset ""` — снесёт заодно `desktop-used-apps`.

### 3.5 «Persistence does not work across reboots» — статус

[**#480235**](https://bugs.kde.org/show_bug.cgi?id=480235): **RESOLVED FIXED, Version Fixed In 6.1.1.**
Корневая причина (Nicolas Fella, MR !289): `DeviceTypes` — это `QFlags`, который не переживает
round-trip через `QVariant`, поэтому сохранённые данные не читались после перезапуска. В памяти
работало, с диска — нет; отсюда симптом «только до перезагрузки». Тестирование автора репорта:
«Without the patch … **it only works until I reboot the system**. With this patch … **persistence
works across reboots too**».

⚠️ **Остаточный хвост открыт.** Комментарий #24 (Sergey, 05.04.2026, **Plasma 6.6.3 + xdp 1.20.3**,
Lamco RDP Server): токен грузится, `persist_mode 2` поддержан, а в ответе «No restore token in
response». Разбор Prajna Sariputra указывает на приложение (три диалога, у третьего вообще нет
галочки восстановления; «Krfb 25.12.3 asks for the same two permissions in one go and **persistence
works there**»). **Harald Sitter, 13.04.2026: «If this is reproducible with Plasma 6.6 please file a
new bug report.»** Итого: исходная причина исправлена, остаточные жалобы вешают на приложения.

**Открытыми против xdp-kde остаются два бага:**
[#504931](https://bugs.kde.org/show_bug.cgi?id=504931) (CONFIRMED, «"Allow restoring on future
sessions" still asks for what to share next time» — окно должно существовать на момент старта;
David Redondo: живое переподключение «is tricky») и
[#488369](https://bugs.kde.org/show_bug.cgi?id=488369) (CONFIRMED, формулировка галочки; там же
историческое признание Nate Graham: «What this checkbox actually does is auto-accept new requests for
the same thing **until the system (or the portal) is restarted**», и ответ Nicolas Fella: «that is a
bug that is fixed with MR !289»).

**Смежные баги, важные для нашего агента:**
- [#522645](https://bugs.kde.org/show_bug.cgi?id=522645) — **FIXED в 6.6.6** (а стенд на 6.6.5):
  xdp-kde **дедлочится, если RemoteDesktop-клиент вышел без `Session.Close`**, и все последующие
  `CreateSession` уходят в таймаут. Вывод обобщается: **всегда звать `Session.Close`.**
- [#517454](https://bugs.kde.org/show_bug.cgi?id=517454) — FIXED 6.6.6: токен выдавался, даже когда
  галочка снята.
- **`ScreenCast.SelectSources` отказывает в персистентности на совмещённой сессии:** `screen-cast.c`
  бросает `"Remote desktop sessions cannot persist"`, если задан `persist_mode`/`restore_token`.
  Для совмещённой сессии персистентность идёт через `RemoteDesktop.SelectDevices`.

### 3.6 Чего портал не даёт принципиально, и что говорят разработчики

Токен без человека не получить: «the recovery token is generated **only with user intervention**, so
there's essentially **no solution** to allow screencasting a window without going through the window
picker» — [#1064](https://github.com/flatpak/xdg-desktop-portal/issues/1064). Jonas Ådahl предлагает
максимум фильтр: «Would it help if you could pass a window title/app-id as a filter, **then still
require the user to click 'Share'**?» — ответ: «Unfortunately not. Needs to be fully without
interaction». Sebastian Wick: «Not a bug, but a feature request».

**David Redondo**, закрывая [#506237](https://bugs.kde.org/show_bug.cgi?id=506237) (пре-авторизация
screencast из CLI) как INVALID — авторитетное «почему нельзя просто подсунуть токен»:
> «Tricky: — we would need to craft restoredata beforehand as xdg-desktop-portal **also needs a
> matching restore token that the app can use** — that needs app cooperation anyway since it needs to
> know the token — we could have an override that skips the dialog for a specific app…»

**David Edmundson** там же: «This end goal here makes sense, and is something we are working towards…
**We also have a semi-hidden method to pre-approve authentication prompts.** See `2d4a4dfe` in
xdg-desktop-portal-kde.»

**David Edmundson**, MR !223 (RemoteDesktop v2 с персистентностью) — важное для не-песочных
приложений: «**A behavioural change is that the old code had a path for non-sandboxed apps to get
access regardless. This has been removed** in leiu of the persistence setting.»

**Plasma 6.5** дал GUI: David Redondo, «Unfortunately we lacked the “configure permissions” part of it
which means **granted permissions disappear into the void and pre-authorization is not possible**.
This changes with Plasma 6.5…» И в ревью (flatpak-kcm MR !155) на вопрос Nate Graham, гарантированно
ли не-flatpak приложения обязаны идти через портал: **David Redondo — «Anything involving screencasts
and fake input needs to go through the portal on wayland.»**

### 3.7 ⚠️ `kde-authorized` — только RemoteDesktop, для ScreenCast его НЕТ

Официальная пре-авторизация KDE
([develop.kde.org/docs/administration/portal-permissions](https://develop.kde.org/docs/administration/portal-permissions),
коммит `2d4a4dfe` Harald Sitter, 30.10.2024 → Plasma **6.3**):
> «interactive permission prompts are nice and all, but sometimes **users need to authorize access to
> resources non-interactively** … we now have a bespoke permission table `kde-authorized`»
> ```
> flatpak permission-set kde-authorized remote-desktop org.kde.krdpserver yes
> flatpak permission-set kde-authorized remote-desktop "" yes   # host app без app_id
> ```

**Жёсткое ограничение, проверенное по исходникам:** единственный потребитель — `src/remotedesktop.cpp`;
`src/screencast.cpp` **вообще не подключает `permission_store.h`**. То есть
**пре-авторизации для чистого ScreenCast не существует** — только для RemoteDesktop.
Документация к коду добавляет: «An application that has an `app_id` **will not be covered by the
empty rule**» (т.е. с пустым id работает правило `""`, но как только id появился — нужно правило на id).

### Насколько это применимо к нам

**Что мы уже делаем правильно:** `persist_mode=2` (единственный надёжный режим) и перезапись токена
новым после каждого `Start` (`portal-screencast.py:98-103`). Это ровно то, на чём спотыкаются
RustDesk и другие. Плюс мы просим **монитор целиком** (`types=1`), а не окно/регион — самый живучий
вариант восстановления.

**Что надо доделать, по убыванию важности:**

1. **Получить настоящий app-id.** Сейчас агент — systemd-служба, т.е. классический пустой app-id.
   Два пути (лучше оба): (а) звать `org.freedesktop.host.portal.Registry.Register("<id>", {})` на
   `/org/freedesktop/portal/desktop` **до любого другого вызова портала** и перерегистрироваться при
   рестарте портала; (б) переименовать юнит в `app-<id>.service` и положить
   `~/.local/share/applications/<id>.desktop`. Без этого: нет изоляции, сессия не видна в
   System Settings, и «запущено иначе → другой app → персистентность отклонена».
2. **Реагировать на отказ восстановления.** Портал при неподходящем токене **молча** покажет диалог.
   Скрипт печатает `REUSED=да/нет`, но агент это не использует. Нужно: `REUSED=да` + диалог/таймаут →
   **удалить файл токена** (лечение из #480235). Иначе можно залипнуть навсегда. Особенно важно
   из-за п.1 в §3.3: отмена диалога уже съела запись.
3. **Всегда звать `Session.Close`.** Сейчас сессия держится жизнью процесса-хелпера
   (`portal-screencast.py`: «Сеанс живёт, пока жив этот процесс»), а при `kill` вызова `Close` нет.
   На 6.6.5 это прямой путь в дедлок [#522645](https://bugs.kde.org/show_bug.cgi?id=522645)
   (исправлено только в 6.6.6).
4. **Учесть, что монитор опознаётся по координатам.** ПК Castiel переключает ОС и живёт с
   выключенными мониторами — исчезновение выхода даст диалог, а **перестановка мониторов молча
   отдаст не тот экран**. Стоит сверять фактический размер/позицию потока с ожидаемым и, при
   расхождении, перезапрашивать согласие явно.
5. **Помнить про Hyprland на этой же машине.** Токен, выданный в KDE, в Ambxst/Hyprland-сессии
   не подойдёт (разные бэкенды и разные теги restore-data) — это не поломка, а ожидаемое поведение;
   логика «токен не подошёл → перезапросить» покрывает и это.
6. **`pipewire-serial` нам пока недоступен** — это ScreenCast v6, а на стенде интерфейс **версии 4**.
   Значит остаёмся на `path=<node_id>` и просто держим в голове, что node ID переиспользуемы.
7. **Если понадобится «совсем без диалога» — только через RemoteDesktop** + `kde-authorized`
   (§3.7). Для чистого ScreenCast такой возможности нет. Заодно RemoteDesktop одним согласием
   покрывает и ввод, который мы и так инжектим (см. §4).

---

## 4. Захват на Plasma 6 БЕЗ диалога портала: что есть и что говорят разработчики KDE

### 4.1 Что технически существует (проверено интроспекцией на живой KWin 6.6.5)

| Интерфейс | Путь | Что даёт | Видео? |
| --- | --- | --- | --- |
| `org.kde.KWin.ScreenShot2` (Version **5**) | `/org/kde/KWin/ScreenShot2` | `CaptureWorkspace/Screen/Window/Area/Interactive` → кадр в pipe fd | только **стоп-кадры** |
| `org.kde.KWin.EIS.RemoteDesktop` | `/org/kde/KWin/EIS/RemoteDesktop` | `connectToEIS(caps) → libei fd` | **НЕТ** |
| `org.kde.KWin.EIS.InputCaptureManager` | `/org/kde/KWin/EIS/InputCapture` | перехват ввода | **НЕТ** |
| **`zkde_screencast_unstable_v1` (v5)** | Wayland-протокол | **реальный видеопуть** — узел PipeWire, DMA-BUF; им пользуется сам xdp-kde | **ДА** |

**Две поправки к распространённым представлениям:**
- **`org.kde.KWin.ScreenCast` не существует** — screencast живёт исключительно как Wayland-протокол.
- **Легаси `org.kde.kwin.Screenshot` (v1) удалён** в Plasma 6. Vlad Zahorodnii предсказывал это в
  2021: «kwin still supports the legacy screenshot dbus interface. But it **will most likely be
  removed in Plasma 6**» — и удалил. Это прецедент к вопросу «уберут ли».

Возможности протокола: `stream_output` (по `wl_output`), `stream_window` (по `window_uuid`),
**`stream_virtual_output`** (виртуальный экран заданного размера); режимы курсора
`hidden=1 / embedded=2 / metadata=4`; ответ — событие `created(node)`
— [wayland.app](https://wayland.app/protocols/kde-zkde-screencast-unstable-v1).
Текст протокола содержит предупреждение: «**Regular clients must not use this protocol.** Backward
incompatible changes may be added without bumping the major version».

### 4.2 Каков реальный гейт авторизации (из исходников + проверено)

`ScreenShot2` (`src/plugins/screenshot/screenshotdbusinterface2.cpp`, Plasma/6.6): KWin берёт PID
вызывающего → `/proc/PID/exe` → ищет через KService **любой проиндексированный `.desktop`, у которого
первый токен `Exec=` канонизируется в этот бинарь** → читает `X-KDE-DBUS-Restricted-Interfaces`.
Для Wayland-протокола гейт отдельный (`src/wayland_server.cpp`): `zkde_screencast_unstable_v1` лежит
в `interfacesBlackList` и анонсируется только если `.desktop` перечисляет его в
**`X-KDE-Wayland-Interfaces`**. Обходы через окружение: `KWIN_SCREENSHOT_NO_PERMISSION_CHECKS=1`,
`KWIN_WAYLAND_NO_PERMISSION_CHECKS=1`.

**Следствия — и здесь community-мнение оказалось НЕВЕРНЫМ:**
- **Путь в `Exec=` должен быть абсолютным.** Aleix Pol (KDE): «The path in `Exec=` needs to be
  absolute for KWin to validate it» — [mail.kde.org](https://mail.kde.org/pipermail/kwin/2024-October/005339.html).
- **Бинарю НЕ нужно быть в `/usr/bin`, а `.desktop` НЕ нужно быть root-owned** — достаточно
  `~/.local/share/applications`. А `~/Desktop` не индексируется KService — вот почему у автора
  форумного треда не работало.
- **У людей это получилось.** rahul vadhyar (рассылка KWin): «**I finally got it working.** I can now
  complete my application» — [mail.kde.org](https://mail.kde.org/pipermail/kwin/2024-October/005340.html);
  EEEntity получал кадры 30–80 fps через `~/.local/share/applications`
  — [discuss.kde.org 43733](https://discuss.kde.org/t/occasionally-freezes-when-using-dbus-to-take-screenshots/43733);
  kde-material-you-colors возит dummy-лаунчер ровно ради этого гранта
  — [issue #179](https://github.com/luisbocanegra/kde-material-you-colors/issues/179).
- **Проверено эмпирически в этом ресёрче** на KWin 6.6.5: бинарь + `.desktop` в
  `~/.local/share/applications` → захват **AUTHORIZED** без диалога; и в Wayland-реестре появился
  `zkde_screencast_unstable_v1 v5`, которого без гранта не было. Грант затем снят, отзыв проверен.

Шаблон — грант самого Spectacle (`/usr/share/applications/org.kde.spectacle.desktop`):
```
Exec=/usr/bin/spectacle
X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2
X-KDE-Wayland-Interfaces=org_kde_plasma_window_management,zkde_screencast_unstable_v1
```

Как это резюмировал участник Arch-форума: «create a .desktop file … that allows eg. `qdbus6` to use
the screenshot protocol (**what of course completely undermines the restriction**). Welcome to the
wonderful world of wayland» — [bbs.archlinux.org 298864](https://bbs.archlinux.org/viewtopic.php?id=298864).

### 4.3 🔴 ГЛАВНОЕ: гейт УДАЛЯЮТ в Plasma 6.8

**MR !6057 «Skip announcing restricted interfaces only to sandboxed clients»**, автор **Vlad
Zahorodnii** (мейнтейнер KWin), milestone **6.8**, влит **2026-06-18**
— [invent.kde.org/plasma/kwin/-/merge_requests/6057](https://invent.kde.org/plasma/kwin/-/merge_requests/6057):

> «There are a few issues with the current approach: first of all, **it provides pseudo-security.
> The desktop files can be changed or overriden by the user, which negates all the benefits.**
> The second issue is that it contributes some overhead… In general, a better approach to restrict
> privileged interfaces is to use the **security context protocol**.»

Коммит «plugins/screenshot: Drop X-KDE-DBUS-Restricted-Interfaces»:
> «The security benefits of the current approach are doubtful… **The best available option at the
> moment are sandbox environments like flatpak.**»

Новый гейт в master: `if (client->isSandboxed()) { return !restrictedInterfaces.contains(name); }
return true;`. Проверка кода по ветвям: `checkPermissions`/`NoAuthorized` присутствуют в 6.5, 6.6,
6.7 и **отсутствуют в master**; `src/utils/serviceutils.h` удалён.
**Plasma 6.8.0 выходит 2026-10-14** ([Schedules/Plasma 6](https://community.kde.org/Schedules/Plasma_6)).

**Значение для нас: на 6.8+ обычный не-песочный нативный бинарь получит и `ScreenShot2`, и
`zkde_screencast_unstable_v1` вообще без `.desktop`-файла и без диалога.** Приватный путь не убирают —
убирают *ограничение*.

Возражения в том же MR (нити помечены resolved, MR влит): Aleix Pol — «Shouldn't we prepare the
replacement first then?»; David Edmundson — «We have to verify how this change affects Snaps».

### 4.4 Что говорят разработчики KDE — дословно

**Nate Graham**, [bugs.kde.org #491037](https://bugs.kde.org/show_bug.cgi?id=491037)
(«Wayland screencopy should make a popup, requesting access from the user») — **RESOLVED WONTFIX**:
> «This would be **ridiculously annoying**. We had it in the past for Spectacle and everyone hated
> it. **Security that annoys people into requesting or finding a workaround to turn it off isn't
> actually real security.**»
> «It doesn't happen for Spectacle and Flameshot because they use a special internal KWin-only
> screenshot API that **bypasses the confirmation prompt, for usability's sake**. … Now, you might
> say, 'the existence of this backdoor means any Wayland app can use it to take screenshots without
> permission on KWin'. **And you would be right. There are trade-offs here.**»
> «**The portal API simply wasn't designed with apps like these in mind.** … This is why you see both
> KDE and GNOME figuring out their own way to bypass these restrictions… These developments indicate
> **fundamental flaws in the design of the portal API**, IMO.»

**Nate Graham** о том, можно ли третьей стороне ими пользоваться
([ksnip discussion #884](https://github.com/ksnip/ksnip/discussions/884)):
> «I believe Spectacle is using custom KWin protocols right now… **KSnip can probably do the same,
> but do realize that the protocols may change at any time.**»

**Aleix Pol** (там же): «You need to specify the restricted interfaces you need in your desktop file…
**We obviously cannot grant every process access to the screenshots infrastructure.**»

**Méven Car** (автор `serviceutils.h`): «You can set the environment variable to get around it…
`export KWIN_SCREENSHOT_NO_PERMISSION_CHECKS=1` … **Those restrictions might be lifted, they are a
bit out of place, I introduced them a while back.**»

**Xaver Hugl (Zamundaaa)** — про портал против хаков, закрывая депрецирование kmsgrab в Sunshine
([#3327](https://github.com/LizardByte/Sunshine/issues/3327)):
> «**There is no way around the portal, and no need to try to work around it either.** With the
> **remote desktop portal**, after getting that initial permission, sunshine gets free access to both
> record all screens and to emulate input devices **without any hacks**.»
> и на возражение про unattended-сценарии: «**Please, do not try to work around problems, it just
> creates more of them.**»

### 4.5 EIS RemoteDesktop — только ввод, видео там нет

`src/plugins/eis/eisbackend.cpp` (Plasma/6.6): `connectToEIS()` **не имеет проверки прав вообще** —
мапит биты в `EIS_DEVICE_CAP_KEYBOARD / POINTER / POINTER_ABSOLUTE / BUTTON / SCROLL / TOUCH` и
отдаёт fd. **Видеовозможности в API нет.** В master появился `eisprompter.cpp` (David Redondo,
«%1 is asking to control input devices»), но он вызывается только из Xwayland-пути, не из D-Bus.
Заявление kwin-mcp «Zero authorization prompts» верно **для ввода**; кадры оно всё равно берёт через
гейтованный `ScreenShot2` (это видно в его собственной схеме).

### 4.6 KMS/DRM — не строить на этом

Единодушно с обеих сторон. **Xaver Hugl (мейнтейнер KWin):**
> «kmsgrab is not a good way to do screen recording and **will only get more problematic over time**,
> as we start to use more hardware features it can't deal with» ([#470440](https://bugs.kde.org/show_bug.cgi?id=470440))
> «Sunshine is known to be broken because it uses kmsgrab which is a **giant hack and cannot ever
> reliably work**» ([#504337](https://bugs.kde.org/show_bug.cgi?id=504337))
> «**kmsgrab should not be used at all, let alone upstream in any project. It's an unreliable hack
> that just causes problems.**» ([r/linux](https://www.reddit.com/r/linux/comments/1t3l0hq/obskmscap_fast_super_low_overhead_display_server/))

**Cameron Gutman** (Sunshine/Moonlight): «kmsgrab's simplistic approach of just grabbing the primary
plane will get more and more broken over time… **They're right that it's a hack**».
Sunshine переехал на порталы (PR #4417, влит 2026-02-03), KMS вынесен в отдельную службу
`sunshine-kms`, потому что **`CAP_SYS_ADMIN` и портал взаимоисключающи**: «setting CAP_SYS_ADMIN on
the Sunshine binary will break XDG Desktop Portal's security policy».

**И `ext_image_copy_capture_v1` в KWin 6.6.5 не анонсируется вообще** (даже гранченному клиенту) —
KWin его не реализует; `wlr-screencopy` — никогда. Значит `grim`/`wf-recorder`/`wl-screenrec`/wlrobs
на KWin невозможны в принципе.

### Насколько это применимо к нам

- **Остаёмся на портале.** Это позиция мейнтейнера KWin, и он подкрепил её тем, что сам провёл
  Sunshine НА портал. Наша архитектура уже там.
- **Диалог убирать не приватным протоколом, а `kde-authorized`** (§3.7) — официально поддерживаемая
  пре-авторизация, Plasma ≥ 6.3. **Но она есть ТОЛЬКО для RemoteDesktop**, для чистого ScreenCast
  её нет (проверено по исходникам: `screencast.cpp` не подключает `permission_store.h`). То есть
  «спросить один раз и никогда больше» = **перейти на RemoteDesktop-портал** + `permission-set`.
  Заодно это ровно то, что описывает Zamundaaa: одно согласие даёт и запись экранов, и эмуляцию
  ввода — а ввод мы и так инжектим. Требует настоящего app-id (§3.4).
- **Если очень нужно «здесь и сейчас» без диалога** — `.desktop` в `~/.local/share/applications`
  с абсолютным `Exec=` и `X-KDE-Wayland-Interfaces=…,zkde_screencast_unstable_v1` **работает**
  (проверено на 6.6.5). Но это ровно то, что Vlad называет «pseudo-security», и Nate предупреждает
  «the protocols may change at any time». Как временная мера — приемлемо; как фундамент — нет.
- **Хорошая новость: с Plasma 6.8 (14.10.2026) ограничение исчезнет само**, и приватный путь станет
  доступен без `.desktop`-костылей. Планировать на это можно, но осторожно: сами интерфейсы остаются
  «desktop environment implementation detail».
- **`ScreenShot2` нам не подходит** — стоп-кадры через pipe, у людей упиралось в производительность
  на 2560×1440.
- **KMS исключён** — `cap_sys_admin` на постоянно работающем агенте неприемлем, и он конфликтует с
  порталом.
- **Ценное «зато»:** `stream_virtual_output` (или `krfb-virtualmonitor` + `capture=kwin`) даёт
  **виртуальный экран нужного разрешения** — прямой путь к «стримить в разрешении окна клиента» без
  EDID-затычек и без `videoscale` в горячем пути. Плюс это снимает часть проблем с физическим
  экраном: в discourse 5570 замечено, что «It looks great and smooth on **virtual** ones…».

---

## 5. WebCodecs `VideoDecoder` + H.264 Annex-B: что ломается и как мерят задержку

### 5.1 MUST-DO — иначе поток не поедет

**(1) Режим определяется ТОЛЬКО наличием `description`.** «If the `description` is not present, the
bitstream is assumed to be in `annexb` format» — [W3C AVC registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/).
⚠️ **`avc: { format: 'annexb' }` на конфиге ДЕКОДЕРА не существует** — это поле только у
`VideoEncoderConfig`. В issue #899 человек его передавал в `VideoDecoder.configure()`, и оно молча
игнорировалось. **Значит наш код (без `description`) уже корректен, и добавлять `avc:{...}` не надо.**

**(2) В annexb каждый keyframe обязан нести SPS+PPS.** Нормативно:
> «If an `EncodedVideoChunk`'s type is `key`, and the bitstream is in `annexb` format, then the
> `EncodedVideoChunk` is expected to contain both a primary coded picture that is an IDR picture,
> **and all parameter sets necessary to decode all video data NAL units** in the chunk.»

Наш `config-interval=1` = «не чаще раза в секунду», keyframe — раз в 2 с ⇒ совпадение не
гарантировано. **Нужно `config-interval=-1`** («send with every IDR frame»). Подтверждение из
практики (Florian Zwoch, [SO 57036353](https://stackoverflow.com/questions/57036353/)):
«**If the receiver misses SPS/PPS headers it will not be able to decode the H.264 stream.**
I guess this can be fixed by using the `config-interval=-1` property of `h264parse`».
Для NVENC отдельно: «`nvh264enc` will insert SPS/PPS only for the first keyframe by default…
**`nvh264enc repeat-sequence-header=true` will insert the headers per keyframe**»
— [discourse 1947](https://discourse.gstreamer.org/t/nvh264enc-not-compatible-with-multifilesink-next-file-2-key-frame/1947).

⚠️ **Но повторять надо БАЙТ-В-БАЙТ одинаковые наборы.** [cisco/openh264#3349](https://github.com/cisco/openh264/issues/3349):
«chromium after each SPS **resets its decoder**, considering that the configuration has changed
(although only `seq_parameter_set_id` changes)» → замерзшее видео на HW-декодере.

**(3) Ошибка «A key frame is required…» — это catch-all, а не диагноз.** Dan Sanders (Chrome):
> «The key frame error refers to the `EncodedVideoChunk.type` field… **This is independent of the
> format of the bitstream; if the bitstream is Annex B then you should not set a `description`**»
> — [SO 73184093](https://stackoverflow.com/questions/73184093/decode-mp4-video-with-videodecoder)

Три разные причины в природе: avcC без `description`; annexb с вырезанными parameter sets
(в [#848](https://github.com/w3c/webcodecs/issues/848) человек фильтровал SPS — Eugene Zemtsov:
«you just skip parameter sets and the decoder never has a chance to process them»; лечение —
«appending the sps data to the start of the first frame packet»); первый чанк вообще не IDR
(«**WebCodecs is more conservative than `<video>` in this regard**»). Плюс баги браузера
([#942](https://github.com/w3c/webcodecs/issues/942) — валидный annexb и всё равно ошибка).

**(4) Одна WS-сообщение = один целый access unit; копить до первого keyframe.** Резолюция
[#698](https://github.com/w3c/webcodecs/issues/698) (WS + сырые NAL, пропало 258 кадров):
> «The key was **waiting (without calling `decoder.decode()`) and accumulating incoming NAL units
> until the first keyframe has been found**… No initial frames are getting lost, and there is a
> **perfect '1 frame in / 1 frame out' behaviour**.»

**(5) Строка кодека должна реально соответствовать потоку.** Специалист по видео на SO: «Your shown
base64 SPS says the codec config is `42E02B` but in your JS code `configure` is using `42E01E`
(they are close, but might not decode)»; рецепт — взять `profile_idc, constraint_flags, level_idc`
из первых трёх байт SPS. **Лучше собирать строку из SPS на стороне Go и присылать клиенту.**

**(6) `frame.close()` обязателен.** Спека: «failing to release them (or waiting for garbage
collection) **can cause decoding to stall**». Кадр 1080p ≈ 10 МБ, часто в GPU-памяти.

**(7) Ошибка декодера терминальна.** MDN: «When a decoder fails, it transitions **permanently** to
the `"closed"` state and a new `VideoDecoder` instance must be created. The first chunk decoded by
the new decoder must be a key frame.» → нужен путь «пересоздать декодер + запросить IDR».

**(8) `flush()` нельзя использовать как трюк для латентности** — он ставит
`[[key chunk required]] = true`. Dan Sanders: «Some codec implementations do allow us to 'flush
without resetting'… but **I am reluctant to specify this feature knowing that not all
implementations can support it**».

**(9) Timestamps должны быть УНИКАЛЬНЫ.** Dan Sanders,
[discussion #565](https://github.com/w3c/webcodecs/discussions/565):
> «**I do not recommend using all-zeros as timestamps; Chrome's implementation uses timestamps to
> link inputs to outputs** and then copy metadata such as `duration`. **It's best if the timestamps
> are unique.**»

### 5.2 Рычаги задержки — по силе эффекта

**Рычаг 1 — убить B-кадры. На Chrome обычно этого достаточно.** Dan Sanders,
[#732](https://github.com/w3c/webcodecs/issues/732) — самое авторитетное объяснение во всём корпусе:
> «There are two steps in decoding H.264; the first produces decoded frames in **decode order**, and
> then the decoded frames sit in a buffer to be output in **presentation order**. **The default size
> of the buffer is large (about 16 frames)**, but it can be reduced in a few ways: … It is possible
> to specify a `bitstream_restriction`, which can limit `max_dec_frame_buffering` and
> `max_num_reorder_frames`… **Chrome's hardware decoders handle reordering themselves, and can in
> most cases reach the limit of `max_num_reorder_frames`. Disabling B-frame encoding therefore is
> usually enough to get 1-in-1-out behavior.**»

**Рычаг 2 — прописать `max_num_reorder_frames=0` в VUI. Это то, что реально помогло.**
Dale Curtis: «you might be able to **inject/rewrite the VUI field for `max_num_reorder_frames` to
zero**»; Eugene Zemtsov тут же: «that's what webrtc does» → референс-реализация
[`sps_vui_rewriter.cc`](https://webrtc.googlesource.com/src/+/refs/heads/main/common_video/h264/sps_vui_rewriter.cc).

Независимое подтверждение с **измеренным эффектом**, и от человека с ровно нашей архитектурой
(WebSocket + WebCodecs, без jitter buffer) — scottlamb, автор moonfire-nvr/retina,
[HN 47372072](https://news.ycombinator.com/item?id=47372072):
> «Skipping the jitter buffer also made me realize with one of my cameras, I had a weird pattern
> where **up to six frames would pile up in the decode queue until a key frame and then start over**…
> even though this camera's H.264 encoder never reorders frames, **they hadn't bothered to say that
> in their VUI bitstream restrictions, so the decoder had to introduce additional latency just in
> case. I added some logic to 'fix' the VUI and now its live stream is more responsive too.**»

Эффект: **6 кадров → 0.** ⚠️ И важное: **`x264 zerolatency` НЕ гарантированно пишет
`bitstream_restriction_flag=1` + `max_num_reorder_frames=0`** — надо проверять парсером.
Целевой набор полей: `max_num_ref_frames=1, vui_parameters_present_flag=1,
bitstream_restriction_flag=1, max_num_reorder_frames=0, max_dec_frame_buffering=1`.

**Рычаг 3 — `optimizeForLatency` работает не так, как кажется.** Dale Curtis,
[#698](https://github.com/w3c/webcodecs/issues/698):
> «`optimizeForLatency: true` **doesn't change how key-frame detection works**… it **also doesn't
> cause flushing. In Chromium, it just means we configure ffmpeg to not use threading for decoding**»

Т.е. **на Chrome это ручка ТОЛЬКО для software-декодера, аппаратный путь она не трогает.** И это
намеренно «best effort»: «The reason I originally went with `optimizeForLatency` is that `lowDelay`
and `lowLatency` don't quite convey the **best effort** nature of the request»; «I'm inclined to
consider this best effort and **ignore it during `isConfigSupported`**» ([#206](https://github.com/w3c/webcodecs/issues/206)).
Youenn Fablet (Apple): «**Safari is not yet really using `optimizeForLatency: true`**».
И отказ усилить формулировку в спеке: «**Ultimately it seems like you're looking for confidence that
you can always rely on 1-in-1-out behavior. I don't think you'll find that to be true**… It's
probably best to submit a test decode on your target platforms».

**Рычаг 4 — подавать по одному чанку на событие `dequeue`.** Dale Curtis:
> «**Yes, just feeding inputs 1 by 1 for each dequeue event until you get the number of outputs you
> want in your steady state is the best way.** It minimizes memory usage.»
> и в 2025 ([#900](https://github.com/w3c/webcodecs/issues/900)): «**Even the user agent can't always
> know if the hardware framework … will want more frames** … Providing inputs until you get an output
> one per dequeue is the only surefire approach at the moment.»
Референс: [`samples/lib/video_renderer.js`](https://github.com/w3c/webcodecs/blob/main/samples/lib/video_renderer.js).

**Рычаг 5 — не морить голодом output-колбэк.** Eugene Zemtsov, воспроизводя «сломанный» поток без
лага: «In order to achieve that, I had to add a small wait after each `decode()` call… **If you keep
feeding frames, the `output` callback simply has no opportunity to run on the main thread.**»
→ **декодировать в Web Worker, рисовать в `OffscreenCanvas`.** Это выглядит точно как «декодер копит
N кадров», а баг совсем другой.

**Рычаг 6 — `prefer-software` надёжно лечит, но дорого.** Подтверждено тремя независимыми
разработчиками (#732, #899, #528: «This behavior doesn't exist on the software decoder»).
Цена: другой путь принимает другие битстримы (#848), Main profile может не поддерживаться (#432),
и CPU на 1080p60 не бесплатен. Paul Adenot (Mozilla) о дырке в API: «the only way for authors to
know is to try».

**Рычаг 7 — платформенные полы, которые не пробить.** Jean-Yves Avenard (Mozilla), #732:
«**The WMF (Windows) decoder has a default latency of about 25+ frames, and if configured for
low-latency will still be around 8 frames** on Windows 8 and 10. FFmpeg, if setup to use n-threads
for decoding will have latency of n-frames. **How the videos were encoded would have zero effects on
the decode-specific behaviour above.**»

**Рычаг 8 — Chrome проверяет соответствие ДО передачи в GPU.** Dale Curtis: «**ffmpeg is indeed far
more resilient than hardware decoders** … we will also **check the bitstream for conformance before
passing to the hardware decoder** in Chromium». Вывод: «играется в ffplay/jmuxer» — **не**
доказательство валидности для Chrome-HW.

### 5.3 Референс-реализация ровно нашей архитектуры

**scottlamb/retina** `examples/client/src/webcodecs/webcodecs.js` (~200 строк) — WebSocket +
WebCodecs без jitter buffer, **<160 мс** glass-to-glass. Решения, которые стоит скопировать:
обработка WS-сообщений через цепочку промисов («each message is processed only after the previous
one completes, so `configure()` always precedes `decode()` calls»); `ws.binaryType = "arraybuffer"`;
рендер — простой `ctx.drawImage(frame, 0, 0); frame.close();`; бинарный протокол с типами
`0x00`=обновление параметров, `0x01`=кадр (i64 µs + key-флаг + данные), `0x02`=число пропущенных;
и **сервер сам держит не-keyframe'ы, пока клиент не получил первый keyframe** (`need_key_frame`).
Его же оценка WebCodecs: «Because WebCodecs doesn't supply a particular jitter buffer implementation,
**you can just not have one at all** if you want to prioritize liveness, and that's what my example
does. A welcome change from using MSE.»

### 5.4 Как мерить

**Метод А (канонический):** снять камерой/скриншотом секундомер и плеер в одном кадре
([transitiverobotics](https://transitiverobotics.com/blog/webrtc-latency-breakdown) читает несколько
подряд: «132 ms, 132ms, 136 ms, 132 ms»).
**Метод Б (для нас):** штамповать на стороне Go µs в `timestamp` чанка и в `output`-колбэке считать
`now − frame.timestamp`; плюс логировать `decodeQueueSize` и число выданных кадров в секунду.
**Стабильный fps при растущем/пилообразном `decodeQueueSize` — это ровно подпись застоя
reorder-буфера.** Известно-хорошая контрольная страница, чтобы отделить «мой битстрим» от «мой
браузер»: [webrtc.internaut.com/wc/wcWorker3](https://webrtc.internaut.com/wc/wcWorker3/) (там
измерено «encode (< 10ms) and decode (< 2 ms)» на M2 Air).

**Порядки величин:** «Full HD video frame encoding in H.264 on typical desktop devices may take
anywhere between **8-20ms**. **Decoding is usually much faster, 1ms on average** … **In all cases,
the first few frames usually take longer to encode and decode, up to a few hundreds of
milliseconds**» — [webrtcHacks](https://webrtchacks.com/video-frame-processing-on-the-web-webassembly-webgpu-webgl-webcodecs-webnn-and-webtransport/).
Последняя оговорка объясняет многие «3 секунды на старте», которые вовсе не reorder-буфер.

### Насколько это применимо к нам

- **`h264parse config-interval=1` → `-1`** (+ `repeat-sequence-header=true` у `nvh264enc`).
  Дешёвая правка, закрывающая класс «видео не появилось / застыло после реконнекта».
- **Проверить VUI нашего x264-потока и, если `max_num_reorder_frames` не 0, — переписать** (референс:
  `sps_vui_rewriter.cc`). Потенциал — до 6 кадров задержки (замерено у scottlamb).
  Для `nvh264enc`: `zerolatency=true` + убедиться, что `bframes=0`.
- **`optimizeForLatency: true` оставить, но не рассчитывать на него** — на HW-пути Chrome он ничего
  не делает. Настоящий рычаг — битстрим.
- **Не добавлять `avc: {format:'annexb'}`** в конфиг декодера — такого поля нет.
- **Строку кодека собирать из SPS**, а не хардкодить `avc1.42E01F`: `x264enc ultrafast` без
  ограничения профиля выдаёт High, и мы объявляем Baseline. Либо пинить
  `video/x-h264,profile=constrained-baseline` (заодно гарантирует отсутствие B-кадров).
- **Проверить, что timestamps уникальны** (Chrome связывает вход и выход по ним).
- **Перенести декодирование в Web Worker + OffscreenCanvas** — иначе можно неделю искать
  «задержку декодера», которая на деле голодание колбэка на main thread.
- **Добавить обработку терминальной ошибки декодера** (пересоздать + запросить IDR) и
  **держать не-keyframe'ы на сервере до первого keyframe** клиента (как retina).
- **Наша нарезка Annex-B по слайсам уже верна** (`first_mb_in_slice == 0`) — здесь это критично:
  чанк обязан содержать кадр целиком. `alignment=au` оставить, `aud=true` у NVENC даст дешёвые
  границы кадров.
- **Один нюанс именно для remote desktop:** худшая задержка будет **на неподвижном экране** — те же
  N кадров буфера при редких кадрах занимают в разы больше реального времени (см. Противоречие №4).
  Это ещё один довод за `keepalive-time` (§2.1): держать пол по частоте кадров.

---

## 6. Чем реально пользуются те, кто добился низкой задержки на Wayland + NVIDIA

### 6.1 Расклад по инструментам

**Sunshine + Moonlight доминирует.** Приоритет бэкендов `nvfbc → wlr → kms → x11`; на Plasma 6
Wayland + NVIDIA это исторически сводилось **только к KMS**: NvFBC — X11-only («The NvFBC desktop
capture library **does not have native Wayland support** and does not work with Xwayland»),
`wlr` — только wlroots, а KMS на NVIDIA стоит round-trip («**KMS has to go from the CPU and back to
the GPU** so that's a small amount of latency added»).

**Событие мая 2026: депрецирование kmsgrab закрыто переходом НА портал** (PR #4417,
v2026.516) — «Added XDG, Pipewire, and KWin direct screencast capture on Linux» + Vulkan-кодирование
+ split-frame encoding — [GamingOnLinux](https://www.gamingonlinux.com/2026/05/sunshine-game-streaming-tool-adds-vulkan-encoding-plus-xdg-pipewire-and-kwin-direct-screencast-capture).
Портальный путь работает **лучше всего как раз на KDE** — [#4662](https://github.com/LizardByte/Sunshine/issues/4662):
«it doesn't work on hyprland. I tested again **on kde plasma and it worked perfectly**».
В логах — ровно наш стек: `Info: [pipewire] Pure NVIDIA system - DMA-BUF will be enabled for CUDA`.

**Остальное:** Apollo/Vibepollo (форки Sunshine, где идёт работа над латентностью 2026),
**Wolf/Games-on-Whales** и **Magic Mirror** и **Polaris/Nova** — все трое **поднимают свой
компositor** вместо захвата десктопа, **GPU Screen Recorder** — эталон «не заикается».

### 6.2 ⭐ Наша архитектура — это архитектура Selkies, и они пришли к ней ОТ WebRTC

Selkies (~1.9k★, поставляется в LinuxServer Webtop) — референс нашего транспорта: «It streams over
**plain WebSockets by default**, with WebRTC available as an opt-in transport». Мейнтейнер @ehfd,
[selkies#48](https://github.com/selkies-project/selkies/issues/48):
> «It might be a good idea to pair **WebSocket + WebCodecs** … **WebCodecs is better than MSE or WASM
> in terms of latency** … In conclusion, I think implementing good old WebSockets has its point.»

И мотив — буквально наш:
> «the possible reason to use this is to **show frames as soon as they arrive instead of going through
> internal jitterbuffers which WebRTC has limited control over**»

Там же — отказ от GStreamer-транспорта («mainly focused on media processing rather than protocols»)
и операционный бонус: «a single TCP port and needs no STUN/TURN server».
LinuxServer.io независимо: «**Enter WebCodecs** … we could build a protocol where we shoot for a level
of quality, not a bitrate. We can **spin the encoder and decoder down to absolute zero when there is
no motion on the screen**» — [Webtop 4.1](https://www.linuxserver.io/blog/webtop-4-1-x11-is-dead-and-what-is-selkies-anyway).

⚠️ **Оговорка:** Selkies валидирует транспорт, но **не** Wayland-захват — их FAQ требует X.Org
(«Wayland … not supported»).

### 6.3 Цифры задержки (только там, где назван стенд)

| Задержка | Стенд / что измерено | Источник |
| --- | --- | --- |
| **15 мс → 4 мс** encode | Arch + **Plasma 6.6 Wayland**, RTX 2060, 1080p60, Apollo. В логах `Attempting to use NVENC without CUDA support. Reverting back to GPU -> RAM -> GPU`; фикс — виртуальный дисплей на выходе dGPU + CUDA | [r/MoonlightStreaming 1sb8104](https://www.reddit.com/r/MoonlightStreaming/comments/1sb8104/poor_encoding_latency_with_apollo_on_linux_using/) |
| **&lt;160 мс** glass-to-glass | **IP-камера → WebSocket → WebCodecs, без jitter buffer** («most of that being the IP camera's encoder») | [scottlamb, HN 47372072](https://news.ycombinator.com/item?id=47372072) |
| **6.0 мс** host processing, без дропов | RTX 5090, **Plasma 6 Wayland, KMS + nvenc**, HEVC, 144 fps | [Sunshine#4567](https://github.com/LizardByte/Sunshine/issues/4567) |
| **~15–20 мс** round-trip | Magic Mirror, **свой Wayland-компositor + Vulkan Video**, локально; «about one frame at 60fps» | [HN 40181947](https://news.ycombinator.com/item?id=40181947) |
| **~2 мс → ~1 мс** | NVENC **split-frame encoding**, 3000×2000@120 HDR | [AMF#593](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/issues/593) |
| **1–2 мс** vs 40 мс | Moonlight 1440p120 против Steam — **но X11 + NvFBC**, на Wayland недостижимо | [LizardByte disc.#17](https://github.com/orgs/LizardByte/discussions/17) |
| **158 мс** медиана, из них **98 мс** jitter buffer | LiveKit/WebRTC 1080p, round-trip по водяному знаку | [gethopp](https://www.gethopp.app/blog/latency-exploration) |
| **322.56 мс** `jitterBufferDelay/Count` | **Selkies в режиме WebRTC**, x264, нестабильный канал | бакалаврская, Masaryk Univ. |
| «largest latency comes from the **browser buffers (~100 ms)**» | Selkies WebRTC в браузере | [blog.e-infra.cz](https://blog.e-infra.cz/blog/witcher-in-browser) |
| **160 мс @30 fps → 30 мс @90 fps** | своё WebRTC + NVENC + aiortc → Chrome | [SO 71392748](https://stackoverflow.com/questions/71392748/h264-via-webrtc-latency-issue) |
| **110 мс** E2E | 4K@60, Rust + WebRTC | [r/rust](https://www.reddit.com/r/rust/comments/1aldku3/) |
| **100–200 мс** vs 25 мс (Parsec) | MediaMTX/WebRTC + Safari, тот же LAN | [mediamtx#4063](https://github.com/bluenviron/mediamtx/issues/4063) |
| **166 мс** при «network <1 мс, host processing 3–4 мс» | RTX 4090 Win11 → Apple TV; «5 frames of delay at 30fps» | [r/MoonlightStreaming 1fzpilc](https://www.reddit.com/r/MoonlightStreaming/comments/1fzpilc/166ms_delay_with_sunshine_moonlight/) |
| enc **8–20 мс**, dec **~1 мс**; первые кадры — до сотен мс | Full HD, типичный десктоп | [webrtcHacks](https://webrtchacks.com/video-frame-processing-on-the-web-webassembly-webgpu-webgl-webcodecs-webnn-and-webtransport/) |
| **MoQ 431–559 мс** vs WebRTC 234–288 vs RoQ 122–215 | remote rendering, Wi-Fi/5G | [arXiv 2505.22132](https://arxiv.org/html/2505.22132v1) |
| «you should be able to do **less than 60 мс**» | `pipewiresrc → nvh265enc → rtph265pay → udpsink`, оценка мейнтейнера GStreamer | [discourse 5693](https://discourse.gstreamer.org/t/pipeline-latency-tuning/5693) |

### 🚩 Скептическая поправка ко всей таблице

Все числа «host processing latency» из Sunshine до 2026 могут быть неверны. Разработчик Vibepollo:
> «I found a bug in Sunshine's host processing latency reporting that made an **8 ms delay show up as
> 10,000 times lower** than it really was… **Sunshine had this bug for over three years and nobody
> noticed.**» — [r/MoonlightStreaming 1smzr22](https://www.reddit.com/r/MoonlightStreaming/comments/1smzr22/)

Плюс из метрики убрали ожидание кадра. **Читать как «только энкодер, без захвата».**

### 6.4 Wayland vs X11, waypipe, MoQ

Инструментальные замеры (marco-nett, июль 2026, 500 Гц, RTX 4070S, KDE, 300 кликов на кейс):
«The 8 main cases all land **within 0.72 ms** of each other (medians 4.21–4.93 ms). **XWayland adds
3.13 ms**». Более ранний тест на NVIDIA/KWin давал «up to 10ms», и Zamundaaa предложил механизм:
«as you're using Nvidia, it might be caused by **tearing not working through Xwayland**».
**Консенсус: компositor стоит ~0.5–1 мс — Wayland не наша проблема.**

**waypipe для этого не годится** — прокси протокола Wayland, не видеопоток: «major window updates
will unavoidably produce a **lag spike**»; заметки автора — «FPS often drops by a factor of 2 or
more». **Игнорировать.** **MoQ** в измерениях хуже WebRTC — тоже мимо.

### 6.5 Консенсус по NVENC для минимальной задержки

- **`zerolatency=true` — единственная безусловная ручка** («Zero latency operation (no reordering
  delay)», дефолт `false`). Она же нужна для 1-in-1-out в WebCodecs (§5) — два требования в одну
  сторону.
- **`rc-mode=cbr`** — во всех реальных low-latency пайплайнах. NVIDIA депрецировала старые имена
  presets/RC в R550 → на 610.x новый API `p1..p7` + `tune=ull`, а не `llhq`.
- **`preset=p1` — НЕ консенсус.** Sunshine: «Higher numbers improve compression … at the cost of
  increased encoding latency. **Recommended to change only when limited by network or decoder**».
  Практики садятся на **p4–p5**.
- **`rc-lookahead=0`** обязателен («latency is roughly look ahead depth divided by frame rate»).
- **`repeat-sequence-header=true`** — дефолт `false`, для браузерного клиента включить (§5.1).
- **`aud=true`** — дешёвые границы кадров в байтовом потоке.
- **`gop-size`** — длинный GOP + IDR по запросу лучше короткого периодического.
- **Split-frame encoding нам недоступен:** нужно ≥2 NVENC-движка, **RTX 3060 (Ampere) имеет один**.
- **Драйверная засада:** «NVIDIA driver has a 'feature' (read: bug) where it will **downclock memory
  transfer rate** when a program uses cuda (or nvenc)» — GSR обходит опцией `-oc` (Sunshine#4567).
- **Sunshine `nvenc_latency_over_power`** стоит украсть концептуально: «Adaptive P-State algorithm
  … doesn't work well with low latency streaming, so sunshine requests high power mode explicitly».

### Насколько это применимо к нам

- **Архитектура WebSocket + WebCodecs подтверждена как осознанно верная** — это выбор Selkies,
  сделанный ПОСЛЕ WebRTC и ровно по нашей причине. Цифры подкрепляют: у gethopp 98 из 158 мс —
  буфер; у Selkies в WebRTC 322 мс; в браузере «~100 ms и почти ничего нельзя сделать». **Не менять.**
- **Референс сошёлся с нами и на захвате** — Sunshine с мая 2026 на XDG-портале + PipeWire, и на KDE
  этот путь работает лучше всего.
- **Реалистичная цель на LAN: 20–40 мс** glass-to-glass (ориентир scottlamb <160 мс включал
  медленный энкодер камеры; у нас NVENC 1–4 мс + декод ~1–2 мс + кадр транспорта). Но только если
  (а) захват реально не идёт GPU→RAM→GPU, (б) битстрим без reordering.
- **Ветку «свой WebRTC» и MoQ можно закрыть.**
- **Наши два настоящих риска — не транспорт:** (1) заикание портального захвата на KWin
  (KDE-баг #520443 открыт, и он не NVIDIA-специфичен), (2) отсутствие прямого DMABUF→NVENC на NVIDIA
  в GStreamer. Если захват окажется ненадёжным, шаблон, к которому пришли ВСЕ успешные проекты —
  **перестать захватывать десктоп и поднять свой компositor** (Wolf `gst-wayland-display`,
  Magic Mirror, Polaris cage). Для нас это дальний, но реальный план Б, и `stream_virtual_output`
  (§4) — его дешёвая половина.

---

## ПРОТИВОРЕЧИЯ

1. **DMA-BUF: форсировать или не трогать.** Один и тот же мейнтейнер GStreamer в одном треде —
   «you may need to **force** it», в другом — «if I **force** non-dmabuf negotiation, we are back to
   the issue». **Разрешение — в коде:** `pipewiresrc` просит DMABuf безусловно, когда продюсер даёт
   модификаторы, и не имеет SHM-фоллбэка; форсирование caps в любую сторону ломает фиксацию.
   Практика: не форсировать, смотреть `GST_DEBUG=4`.

2. **`cudaupload`: «нужен для GPU» против «в 3 раза медленнее».** Массовые гайды ставят
   `cudaupload ! cudaconvert` перед `nvh264enc`; бенчмарк и **автор плагина** говорят, что
   скармливать RGB напрямую быстрее, потому что NVENC всё равно запускает CUDA-ядро.
   **Мы следуем автору плагина** (§1.1).

3. **Zero-copy: благо или голодание.** «doing zero copy with it **often results in starvation** …
   cop[y] ASAP» против «OBS does use DMAbuf whenever possible **to avoid copies**» — и OBS эталон
   плавности. **Разрешение:** OBS управляет буферами сам, минуя `pipewiresrc`; слабое звено —
   буферпул GStreamer-элемента, и это признают Collabora, Kiagiadakis («weirdly bypasses the buffer
   pool using a hack that I did not want to touch») и Raghavan («no clear answer is apparent yet»).

4. **Аппаратный декодер копит фиксированное число кадров или нет?** Репортёр #899 после правки
   `max_num_reorder_frames=0` не увидел изменений: «This makes me believe that the hardware
   accelerated `VideoDecoder` is buffering constant number of frames all the times». Dale Curtis
   категорически: «**Chrome's code definitely doesn't buffer a constant number of frames** — we have
   cases of 1-in-1-out working when the bitstream is setup correctly». Баг
   [crbug 436302044](https://issues.chromium.org/issues/436302044) **открыт, не разрешён**.
   → правка VUI **необходима, но не всегда достаточна** (как минимум на VideoToolbox).
   **Побочная находка того же треда, важная для remote desktop:** «I still see the 2-3 sec delay
   **when there is not much changes on the Desktop**, but … very minimal delay when I play a video».
   Объяснение никто не дал; правдоподобное — те же N кадров буфера при редких кадрах занимают в
   разы больше реального времени. То есть **худшая задержка будет на неподвижном экране**.

5. **Кто виноват в заикании захвата: KWin, pipewiresrc, GNOME или NVIDIA.** Все четыре версии
   документированы: «this is a KDE issue. Specifically a KWin issue» против «Problem does **not**
   exist in KDE Plasma» ([sway#9177](https://github.com/swaywm/sway/issues/9177)) и «I don't have an
   issue with this at all under KDE» ([mutter#4214](https://gitlab.gnome.org/GNOME/mutter/-/issues/4214))
   против NVIDIA-специфичных «пустых буферов». **Решающая улика против «это NVIDIA»:** открытый
   KDE-баг [#520443](https://bugs.kde.org/show_bug.cgi?id=520443) воспроизводится на **AMD**.
   **Вывод:** это как минимум три независимых бага с одним симптомом — (а) variable-rate доставка +
   дроп дубликатов (компositor), (б) хрупкая работа `pipewiresrc` с буферами/DMA-BUF (GStreamer),
   (в) периодические регрессии троттлинга KWin (5.27.5–5.27.10; 6.7 на NVIDIA).

6. **Персистентность портала: «сделано и исправлено» против «до сих пор спрашивает».**
   [#445875](https://bugs.kde.org/show_bug.cgi?id=445875) FIXED 5.25, [#454128](https://bugs.kde.org/show_bug.cgi?id=454128)
   FIXED 5.25, [#486387](https://bugs.kde.org/show_bug.cgi?id=486387) FIXED 6.1.0,
   [#480235](https://bugs.kde.org/show_bug.cgi?id=480235) **FIXED 6.1.1** — и при этом
   [#504931](https://bugs.kde.org/show_bug.cgi?id=504931) и [#488369](https://bugs.kde.org/show_bug.cgi?id=488369)
   до сих пор CONFIRMED-открыты, а в #480235 висит комментарий от апреля 2026 про Plasma 6.6.3.
   **Разрешение:** каждый конкретный баг был реален и исправлен; остаточные жалобы KDE в большинстве
   случаев обоснованно вешает на приложения (не передали `persist_mode`, не перезаписали токен,
   запускаются каждый раз «по-разному»). `persist_mode=1` ненадёжен, `2` работает.
   **Вывод:** «работает» и «не работает» оба правдивы; выживает тот, кто умеет перезапросить согласие.

   **Отдельно — «новый токен каждый раз» (спека) против «оба портала переиспользуют тот же токен»
   (наблюдение).** Спека: «The restore token is invalidated after using it once… use the **new**
   restore token»; Prajna Sariputra: «both the GNOME and KDE portals appear to **just use the same
   token anyway**». **Разрешено по коду:** новый токен генерируется только если приложение своего не
   прислало; одноразовой является **запись в permission store** (удаляется на `SelectSources`,
   создаётся заново в `Start`), а не строка. Оба утверждения верны; правило «перезаписывать тем, что
   вернул `Start`» остаётся.

7. **`optimizeForLatency`: помогает или нет.** «**may** also help in some cases» и «in Chromium, it
   just means we configure ffmpeg to not use threading» (т.е. HW-путь не трогает) против ожиданий
   разработчиков. Отдельно [#491](https://github.com/w3c/webcodecs/issues/491): на 4K
   `true` оказался **в 2× медленнее** по пропускной способности (открыт с 2022).
   **Вывод:** флаг оставить, но задержку определяет битстрим.

8. **`.desktop`-грант: «нужен привилегированный каталог» — НЕВЕРНО.** Топовый ответ в форуме KDE
   утверждает «the .desktop file has to exist in a privileged directory, like /usr/share/applications,
   where only root has write access». Проверено на KWin 6.6.5: `~/.local/share/applications`
   работает. Реальная ошибка автора была в `~/Desktop`, который KService не индексирует. И это же
   подтверждает коммит Влада: «The desktop files can be modified or overriden by the user, which
   makes the checks pointless».

9. **Приватные интерфейсы KWin: «нельзя» против «Sunshine так делает» против «ограничение снимаем».**
   Текст протокола — «Regular clients **must not** use this protocol»; Sunshine его биндит
   (`capture = kwin`); Nate Graham — «KSnip can probably do the same, but … **the protocols may
   change at any time**»; Vlad Zahorodnii одновременно **удаляет саму проверку** в 6.8 как
   «pseudo-security»; и он же в Sunshine пишет «**There is no way around the portal, and no need to
   try to work around it either**». Позиции KDE внутренне не едины по способу, но едины по сути:
   гарантий стабильности приватного пути нет.

10. **KMS: «депрецируется/хак» против «единственный правильный».** Мейнтейнер KWin — «giant hack and
    cannot ever reliably work»; гайды в это же время — «lowest capture latency available on Linux»
    с HDR и без диалогов. Разрешилось событием: в мае 2026 появились XDG/PipeWire/KWin-бэкенды.

11. **Портальный захват — zero-copy или двойная композиция?** Автор obs-kmscap утверждает, что «it
    bypasses the double compositing that Pipewire implicates»; когда попросили обосновать, ответ был
    спекулятивным: «should be fully zero copy, but in practice it could be fucked up/broken who
    knows». **Цифр никто не привёл** — а для нашего дизайна это несущий вопрос.

12. **DMA-BUF на NVIDIA помогает или мешает?** В [Sunshine#4567](https://github.com/LizardByte/Sunshine/issues/4567)
    репортёр сначала «disabling DMA-BUF fixes the GPU utilization issue», потом отозвал («I made a
    dumb mistake during testing»), потом — «using the new Vulkan encoder with Portal capture fixes
    both … Previously I was getting 10% FPS drop in games, now it's negligible».

13. **NVENC не автоматически быстрее software.** [Sunshine#316](https://github.com/loki-47-6F-64/sunshine/issues/316)
    измерил NVENC на **~20 мс хуже** программного. Примиряется находкой про GPU→RAM→GPU при
    отсутствии CUDA (§6.3).

14. **Sunshine теряет 25–30% производительности GPU на Linux, причина неизвестна** (#4567, открыт с
    января 2026, воспроизведён на 5090/5080/5070Ti/4060/3070, KMS **и** NvFBC, nvenc **и** software):
    «Not streaming: 99% GPU utilization / Stream @ 144 fps: 70%», на Windows 97%+, а GPU Screen
    Recorder потерь не даёт. Значит это пайплайн Sunshine, не драйвер.

15. **Повторять ли SPS/PPS?** Спека: да, обязательно в annexb. openh264#3349 + Chromium: повторный
    SPS с меняющимся `seq_parameter_set_id` **сбрасывает декодер и морозит HW-видео**. Защита Cisco:
    «As the complex network environment, resolution change, package loss may occur very frequent, so
    it's not a good idea to keep only one SPS/PPS». Оба правы: повторять, но **байт-в-байт**.

16. **Правка SPS/VUI — законно или нет?** Инженеры Chrome рекомендуют (и указывают на продакшн
    `sps_vui_rewriter.cc`), а специалисты по видео на SO предупреждают «If you modify it, the decoder
    will not be able to decode the video properly». Примирение: править **только** поля
    `bitstream_restriction` с корректным RBSP-перекодированием и emulation-prevention — это то, что
    WebRTC возит в продакшне; ручные hex-правки — нет.

17. **Firefox: таблицы совместимости против отчётов.** caniuse говорит «WebCodecs с Firefox 130+
    включая Linux»; [Bugzilla 1918769](https://bugzilla.mozilla.org/show_bug.cgi?id=1918769) —
    H.264-контент «cannot be recognized as avcc or annexb format», подтверждено на
    **Ubuntu 22.04 / Firefox 137** и Mint 22 / FF 138, где `isConfigSupported()` возвращает `true`,
    а `configure()` бросает. Приоритет понижен P2→P3, открыт больше года.
    **Для нас:** если Linux-Firefox в планах — тестировать рано, `isConfigSupported()` там врёт.
    (Argus на Electron/Chromium, так что сейчас не блокер.)

18. **Ощущения против измерений.** «Running Wayland seems to add tons of latency, feeling like 200+
    ms of inputlag» против инструментальных ~0.5–1 мс. Рамка (Jeff Kesselman): «If you cant perceive
    the difference then its irrelevant».

---

## ОТЧЁТ О ПОКРЫТИИ

### Где искал

- **Поисковики:** tavily (основной, `search_depth=advanced`), встроенный WebSearch, searxng,
  Discourse JSON API (точные ники/даты/trust-level), GitHub GraphQL, `gh`, bugs.kde.org REST.
  Раунды по каждому из 6 вопросов + синонимы, до двух раундов без новых доменов.
- **Прочитано с комментариями:** GStreamer Discourse — 182, 971, 1223, 1947, 2413, 3987, 4760, 4764,
  4856, 4959, 5426, 5482, 5570, 5575, 5693, 5806, 5812, 5825 · bugs.kde.org — 445875, 446628,
  469777, 470155, 470440, 476186, 476602, 480235, 491037, 495287, 495788, 500261, 504337, 514179,
  519122, 520443, 522041, 523484 · invent.kde.org — **MR !6057** (+коммиты), xdp-kde #7, MR !577,
  MR !326, plasma-meetings#12 · рассылка KWin (005333–005340) · discuss.kde.org — 6680, 13593,
  21495, 42057, 43733, 44553 · develop.kde.org (portal-permissions) · Planet KDE (David Redondo) ·
  GNOME GitLab — mutter #3758/#3903/#4214, gimp #5785 + work item 6626 · flatpak/xdg-desktop-portal
  — #324, #649, #1037, #1064, #1124 · PipeWire GitLab — 31, 1793, 3670, 4012, 4064, 4765, 4888,
  5257, 5326 · GStreamer GitLab — 3581, 4181, 5099 · Arch BBS — 298864, 306394, 306440, 311497,
  311914, 311940 · OBS Forums 172753 · NVIDIA devforum — 249906, 273368, 278807 · GitHub:
  w3c/webcodecs #116/#206/#285/#432/#491/#528/#698/#732/#848/#867/#899/#900/#942 + discussions
  #565/#680, LizardByte/Sunshine #316/#1320/#3327/**PR#4417**/#4567/#4662/#4884/#4982 + discussions
  #17/#402, moonlight-qt #1032, games-on-whales wolf#350 + gst-wayland-display, selkies#48,
  xdg-desktop-portal-wlr #351 + PR#370, sway#9177, gamescope#900, xdp-hyprland #123/#302,
  obs-studio#11580, AMF#593, cisco/openh264#3349, ksnip#884, flameshot#1380,
  kde-material-you-colors#179, isac322/kwin-mcp, danchitnis/LLrdc, helixml/helix (3 design-дока),
  project-monitorize, jhonsnake/sunshine-kde-virtual-display, **scottlamb/retina** (полный разбор
  клиента), PipeWire исходники, NixOS/nixpkgs#262976 · **исходники KWin** (master/6.7/6.6/6.5:
  `screenshotdbusinterface2.cpp`, `serviceutils.h`, `wayland_server.cpp`, `eisbackend.cpp`,
  `screencaststream.cpp`) · Hacker News — 38069974 (все 77 комментариев), 38071823, 40181947,
  42352892, **47372072** · StackOverflow — 20682275, 23404403, 51162083, 57036353, 66626776,
  71392748, 72810404, 73184093, 74098842, 74687061, 75849048, 77609003, 79264506, 79675588 ·
  chromium media-dev (KU8OJE_s8Yk) · Bugzilla Mozilla 1918769 · Reddit — r/linux_gaming, r/kde,
  r/gstreamer, r/pipewire, r/rust, r/archlinux, r/MoonlightStreaming, r/linux, r/selfhosted ·
  privacyguides 19910 · блоги/доки: Jan Grulich, Zamundaaa, Arun Raghavan, Collabora,
  George Kiagiadakis, dec05eba (GSR), LinuxServer.io, gethopp, transitiverobotics, webrtcHacks, MDN,
  Chrome for Developers, thenets.org, nite07.com, marco-nett, blog.e-infra.cz, ctt.cx, membrane.stream ·
  W3C (WebCodecs + AVC registration) · NVENC SDK 13.0 guide · wayland.app · docs.lizardbyte.dev ·
  arXiv 2505.22132, 2511.18687 · бакалаврская Masaryk University.
- **Прочитаны исходники** (не только обсуждения): KWin master/6.7/6.6/6.5 —
  `screenshotdbusinterface2.cpp`, `serviceutils.h`, `wayland_server.cpp`, `eisbackend.cpp`,
  `screencaststream.cpp`; xdg-desktop-portal — `xdp-session-persistence.c`, `screen-cast.c`,
  `xdp-app-info-host.c`, `xdp-types.h`, `xdg-permission-store.c`,
  `org.freedesktop.host.portal.Registry.xml`; xdg-desktop-portal-kde — `screencast.cpp`,
  `remotedesktop.cpp`, `outputsmodel.cpp`, `restoredata.h`; flatpak-kcm — `restoredatamodel.cpp`,
  `appsmodel.cpp`, `permissionstore.cpp`; PipeWire — `src/gst/gstpipewiresrc.c` (+ история коммитов);
  WebRTC — `common_video/h264/sps_vui_rewriter.cc`; клиент scottlamb/retina.
- **Проверено эмпирически** (на живой KWin 6.6.5, в рамках ресёрча, всё возвращено в исходное
  состояние): интроспекция `org.kde.KWin.ScreenShot2` (Version=5) и обоих EIS-объектов; воспроизведён
  `NoAuthorized`; воспроизведён и **затем отозван** грант через `.desktop` в
  `~/.local/share/applications`; перечислен Wayland-реестр без гранта и с грантом
  (`zkde_screencast_unstable_v1 v5` появляется только с грантом); подтверждено отсутствие легаси
  `/Screenshot` и `ext_image_copy_capture_v1`; интроспектирован
  `org.freedesktop.host.portal.Registry.Register` и проверено, что без `.desktop` он падает с
  `App info not found`; проверены версии интерфейсов портала (**ScreenCast v4**, RemoteDesktop v2) и
  что таблицы permission store пусты; проверены регексы имён systemd-юнитов `app-<id>.service`.
- **Локально сверено с кодом Argus:** `agent/wayland_linux.go`, `agent/helpers/portal-screencast.py`,
  `src/renderer/src/lib/agentClient.ts`.

### Чего не удалось достать

- **firecrawl MCP — мёртв весь прогон:** `Insufficient credits` (HTTP 402) и на `firecrawl_search`,
  и на `firecrawl_scrape`. Всё извлечение шло через `tavily_extract` (`extract_depth=advanced`).
- **searxng — деградирован:** основной пул «под капчей», фоллбэк отдавал китайский SEO-мусор.
  По этой теме бесполезен.
- **Reddit — только частично.** `dig-comments.sh`, WebFetch и прямой curl (включая old.reddit и
  redlib) дают **HTTP 403**. `tavily_extract` вытаскивает часть комментариев, но не всегда тело
  поста и почти никогда полное дерево; батч из нескольких URL возвращает боковой мусор, поэтому
  Reddit читался по одному URL, `format=text`.
  **Конкретно не добыто:** r/MoonlightStreaming 1sxg2gs (196 комментариев) — пусто, заменено на
  README проекта; r/linux_gaming 1e3xnj4 (GSR vs OBS) — вернулось содержимое r/worldbuilding;
  r/kde 1cn1nn8 — пусто; комментарии к r/pipewire 16gdwbg, где автор пишет «I had no luck with
  gstreamer's nvidia stuff like `nvh264enc`» и гонит BGRA через fifo в `ffmpeg -c:v h264_nvenc` —
  это FAILED-ATTEMPT-датапоинт, ответы к которому прочитать не удалось.
- **`issues.chromium.org` / `bugs.chromium.org` — недоступны анонимно** (SPA + auth): 1352442
  (канонический баг Chrome про 1-in-1-out), 1462868, **436302044** (нерешённый спор из Противоречия
  №4), 424836493, 365493100. Их содержание существенно процитировано внутри тредов w3c/webcodecs,
  но внутренние ответы Google прочитать не вышло.
- **GitLab REST/notes API → `401 Unauthorized`** для freedesktop и invent.kde.org. Обход нашёлся
  (`discussions.json`), и через него прочитаны полные ветки MR !79, !223, !289, flatpak-kcm !155/!169.
  Но вложенные ветки **MR !6057** (5 ответов под Aleix Pol, 4 под David Edmundson) и комментарии
  PipeWire #3670/#4012/#4888 остались частичными; резолюции закрытых #3670 и #4012 не верифицированы.
- **Плохо покрыт трекер OBS Studio и объём пользовательских жалоб на r/kde / r/linux_gaming
  по теме персистентности** — по этому под-вопросу читались в основном KDE-трекер, upstream-issues и
  исходники. Заявления разработчиков OBS в отчёте отсутствуют.
- **Вложения `sps-BASELINE.json` / `sps-MAIN.json`** в webcodecs#732 (те самые дампы SPS,
  различающие рабочий и сломанный поток) — GitHub больше не отдаёт `files/`-ссылки 2023 года.
- **Цитата «I will close all bug reports about anything using kmsgrab breaking»** — пересказ из
  KDE Matrix без публичного архива; вместо неё приведены официальные заявления того же разработчика.
- **HN-тред про Neko** — таймаут. **bugs.kde.org прямой fetch** один раз отвалился по таймауту (134 с).
- **Списки рассылки pipewire-devel / gstreamer-devel** просмотрены только через поисковую выдачу;
  постранично архивы не обходились (плохо индексируются, а живая дискуссия 2024–2026 шла в
  GitLab-issues и на Discourse).
- **Не проверено на целевой машине.** Ресёрч шёл с ноута (Vivobook): здесь нет NVIDIA
  (`/proc/driver/nvidia/version` отсутствует), `gst-inspect-1.0 nvcodec` → `0 features` +
  `CUDA library "libcuda.so.1" was not found`, `pipewiresrc` не установлен. Целевой стенд с RTX 3060 —
  ПК Castiel, и **утверждение «доступен nvcodec» на нём не подтверждено**. Первые команды на стенде:
  `gst-inspect-1.0 nvcodec`, `gst-inspect-1.0 pipewiresrc`, `wayland-info | grep zkde_screencast`,
  `pw-top`, `journalctl --user -g "Dropping a screencast frame"`.
- **Brave на CDP :9222 был доступен** (`Chrome/148`), но не понадобился.

### Главные не закрытые пробелы

1. **Нет ни одного отчёта с измеренной задержкой для связки «Wayland-портал → NVENC → WebSocket →
   WebCodecs».** Ближайшие аналоги: Selkies (тот же транспорт, но на X.Org), scottlamb/retina
   (тот же транспорт, но источник — IP-камера, <160 мс), LLrdc (архитектура без чисел).
   **Свои цифры придётся мерить самим** — методика в §5.4.
2. **Никто не подтвердил «`pipewiresrc` → стабильные 60 fps на KWin Plasma 6»** с замером счётчиком
   кадров. Считать недоказанным.
3. **Спор о «двойной композиции» портального пути численно не разрешён** (Противоречие №11) — а для
   нашего дизайна это несущий вопрос.

### Итог по методу

Ключевые находки пришли **именно из комментариев, ответов и исходников**, а не из заголовков и
документации: `keepalive-time` как решение (§2.1 — ответ автора самому себе на следующий день);
`cudaupload` в 3× медленнее (§1.1 — бенчмарк пользователя + объяснение автора плагина);
урезание буферов в KWin 6.6.4 (§1.5 — «Issue founded» в свежем треде); дроп дубликатов в KPipeWire
(§0/§2.1 — комментарий 8 в баге со статусом NEEDSINFO); удаление гейта в Plasma 6.8 (§4.3 — описание
MR и текст коммита, а не анонсы); `max_num_reorder_frames` вместо `optimizeForLatency` (§5.2 — ответ
инженера Chrome + измерение «6 кадров → 0» в комментарии на HN); официальный `kde-authorized`
(§3 — страница администраторской документации, на которую в обсуждениях почти не ссылаются);
и опровержение мифа про «привилегированный каталог» для `.desktop` (Противоречие №8 — проверено
экспериментом на живом KWin).
