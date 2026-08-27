---
type: research
date: 2026-07-30
project: Argus
scope: Linux / KDE Plasma 6 / Wayland / PipeWire / GStreamer / NVENC / WebCodecs
sources:
  - https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html
  - https://gstreamer.freedesktop.org/documentation/nvcodec/nvh264enc.html
  - https://gstreamer.freedesktop.org/documentation/nvcodec/cudaupload.html
  - https://gstreamer.freedesktop.org/documentation/nvcodec/cudaconvert.html
  - https://gstreamer.freedesktop.org/documentation/opengl/glupload.html
  - https://gstreamer.freedesktop.org/documentation/opengl/glcolorconvert.html
  - https://gstreamer.freedesktop.org/documentation/additional/design/dmabuf.html
  - https://gstreamer.freedesktop.org/documentation/additional/design/probes.html
  - https://gitlab.freedesktop.org/pipewire/pipewire/-/blob/3d520f1d879482d0bb590a353e891fd145f68954/src/gst/gstpipewiresrc.c
  - https://invent.kde.org/plasma/kwin/-/blob/452707eb5d948e69a9e506963fc49c75ff454f6c/src/plugins/screencast/screencaststream.cpp
  - https://invent.kde.org/plasma/kwin/-/blob/452707eb5d948e69a9e506963fc49c75ff454f6c/src/wayland_server.cpp
  - https://www.w3.org/TR/webcodecs/
  - https://websockets.spec.whatwg.org/
  - https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/34b38971549d61b3ba39106307e13c1d27957347/subprojects/gst-plugins-bad/sys/nvcodec/gstnvh264encoder.cpp
  - https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html
  - https://invent.kde.org/libraries/plasma-wayland-protocols/-/blob/c421474708c26a409817c255e1c43939351444d8/src/protocols/zkde-screencast-unstable-v1.xml
  - https://invent.kde.org/plasma/kwin/-/blob/452707eb5d948e69a9e506963fc49c75ff454f6c/src/plugins/screenshot/org.kde.KWin.ScreenShot2.xml
  - https://invent.kde.org/plasma/kwin/-/commit/0ea31ae72eb052cb9c9cc508318fc3f0f329ed53
  - https://invent.kde.org/plasma/krdp/-/blob/c0cbeaca32b4c0535fd0bbd9ce561db5ed50fb78/src/screencasting.cpp
  - https://invent.kde.org/network/krfb/-/blob/d90de088925651531018dd9e6ca441bdedb5b70b/framebuffers/pipewire/screencasting.cpp
  - https://invent.kde.org/plasma/spectacle/-/blob/e7cd33e2136f35fa2af5644732f98fb326d91ce0/src/Platforms/ImagePlatformKWin.cpp
  - https://invent.kde.org/plasma/spectacle/-/blob/e7cd33e2136f35fa2af5644732f98fb326d91ce0/src/Platforms/screencasting.cpp
  - https://invent.kde.org/plasma/xdg-desktop-portal-kde/-/blob/4d45072cf64fa1a2be026aedda95eeaab877be5b/src/screencast.cpp
---

# Argus: независимый разбор трансляции экрана на Linux/Wayland

Срез источников: **2026-07-30**. Исходники KDE проверены на состояниях `kwin` от
2026-07-29 (`452707e`), `xdg-desktop-portal-kde` от 2026-07-29 (`4d45072`), KRdp от
2026-07-29 (`c0cbeac`), KRfb от 2026-07-27 (`d90de08`) и Spectacle от 2026-07-29
(`e7cd33e`).

## Короткий вывод

1. Для RTX 3060 лучший путь без копирования пикселей через CPU — **PipeWire DMA-BUF →
   EGL/GLMemory → GPU-конвертация в NV12 → `nvh264enc`**. `cudaupload` в таком пути не
   обязателен: `nvh264enc` умеет принимать `GLMemory`. Это не обещание буквального zero-copy
   внутри GPU: GStreamer может сделать GL→CUDA device-to-device copy, но чтения/конвертации
   полного кадра CPU уже нет.
2. Если GL/CUDA interop на конкретной сборке не завёлся, практичный fallback — **PipeWire
   MemFd/system memory → `cudaupload` → `cudaconvert` → CUDAMemory/NV12 → `nvh264enc`**.
   Здесь одна неизбежная host→device загрузка; `videoconvert`, `videoscale` и `cudadownload`
   не нужны.
3. Родной пиксельный размер надо брать не из portal `streams[].size`: по freedesktop это
   размер в координатах композитора, который может отличаться от пиксельного размера потока.
   Истина — **зафиксированные GStreamer caps после `pipewiresrc`** (и затем SPS/caps
   `h264parse`).
4. `nvh264enc.bitrate` действительно меняется в состоянии PLAYING. На устройстве с
   `NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE` GStreamer вызывает мягкий NVENC Reconfigure на
   следующем кадре. Pad-probe и переоткрытие portal-сеанса не нужны. Но текущий
   `gst-launch-1.0` — непрограммируемый subprocess; нужен маленький GStreamer helper, который
   держит ссылку на элемент `enc` и принимает команды.
5. Для target fps не надо возвращать ни жёсткий source caps, который уже дал
   `not-negotiated`, ни `videorate`, который на damage-driven stream добавил задержку.
   Практичный limiter — мгновенно ронять лишние raw buffers по PTS до GPU upload.
6. В Plasma 6 **нет актуального D-Bus API `org.kde.KWin.ScreenCasting`**. Есть приватный
   Wayland-протокол `zkde_screencast_unstable_v1`. KRdp, KRfb, video-ветка Spectacle и KDE
   portal используют именно его. Несandboxed процесс в пользовательском Wayland-сеансе
   технически может захватывать без portal-диалога, но XML прямо запрещает считать этот
   протокол API для обычных клиентов. Для Argus устойчивый путь — portal +
   `persist_mode=2`/одноразово обновляемый `restore_token`.

## Что делает код сейчас

Путь данных прослежен по указанным файлам и по фактически вызываемому
`agent/helpers/portal-screencast.py`. Важно различать два среза: живой установленный агент из
условия всё ещё сообщает `source=pipewire-portal encoder=x264, fps=30`, а в working tree во
время этого исследования появилась параллельная WIP-ветка NVENC/native-size. Я её не менял,
но итоговый разбор ниже учитывает и её:

- `main.go:36-39` по умолчанию задаёт 30 fps, 1920×1080, 8000 кбит/с. Новая
  `waylandEncoders`-ветка переопределяет ориентир аппаратных вариантов на 60, программного на
  30.
- WIP уже добавляет каскад `nvh264enc → vah264enc → x264`, но первый NVENC-путь всё ещё имеет
  `always-copy=true` и CPU `videoconvert ! video/x-raw,format=NV12` **до** `cudaupload`.
  Поэтому это аппаратное кодирование, но ещё не minimum-copy pipeline.
- Второй NVENC fallback передаёт system-memory NV12 прямо в `nvh264enc`; encoder сам делает
  upload. Ни один текущий вариант не использует DMA-BUF→GLMemory.
- В caps **нет реального ограничения fps**. Комментарий WIP фиксирует важный стендовый факт:
  caps range сразу после `pipewiresrc` дал `not-negotiated`, а `videorate` на damage-driven
  portal stream удерживал кадр и создавал секундную задержку. Поэтому значения 30/60 в
  `captureDims` и `hello` — ориентир encoder/GOP, не измеренная частота; под нагрузкой источник
  может идти с refresh rate монитора.
- Helper теперь печатает `SIZE` до `NODE`, Go его читает и передаёт через `captureDims` в
  `hello`. Но это **не исправляет корень**: portal `size` логический, а не обязательно
  пиксельный. Комментарии `portalStream` называют его «родным разрешением» ошибочно. При
  fractional scaling `hello` всё ещё может врать, а условие запуска `videoscale` сравнивает
  пиксельную задачу с логическим размером.
- `parseSize()` заранее округляет portal size вниз до чётного. Выравнивать надо реальный
  encoded pixel size после caps negotiation, а не compositor coordinates.
- Renderer после декодирования сам меняет canvas по `VideoFrame.displayWidth/displayHeight`
  (`agentClient.ts:120-127`), то есть картинка способна самоисправиться, но `hello` и UI-
  метаданные могут остаться неверными.
- `agentClient.ts:111` всегда увеличивает timestamp на `1_000_000/60`, независимо от `hello.fps`.
  Для 30/24/15 fps и измерения задержки это неверно.
- `hello.codec = avc1.42E01F` жёстко объявляет H.264 Baseline level 3.1, хотя NVENC может
  выбрать другой профиль/level, а 1080p30 обычно требует level выше 3.1. Codec string должен
  происходить из реального SPS/caps, а не из константы.
- Portal helper не вызывает обязательный по API `OpenPipeWireRemote`; агент
  подключается к общему PipeWire по node ID. Это работает на стенде как unsandboxed клиент,
  но не является полным контрактом portal. В ScreenCast v6 node ID ещё и объявлен
  устаревшим из-за повторного использования после hotplug/suspend; предпочтительны
  `pipewire-serial` и `PW_KEY_TARGET_OBJECT`.

---

## 1. PipeWire → H.264 Annex-B через NVENC с минимумом копирований

### 1.1. Что реально отдаёт KWin

KWin не выдаёт только «обычный RGB в RAM». В актуальном
[`screencaststream.cpp`](https://invent.kde.org/plasma/kwin/-/blob/452707eb5d948e69a9e506963fc49c75ff454f6c/src/plugins/screencast/screencaststream.cpp#L423)
он:

- пытается создать DMA-BUF и объявляет DRM modifiers;
- при наличии DMA-BUF предлагает его первым;
- **всегда добавляет SHM/MemFd fallback** (`buildFormats`, строки 762–787);
- для обычного output берёт `m_output->pixelSize()`, а базовым форматом служит
  ARGB8888/BGRA или BGRx;
- согласует реальный размер и максимальную частоту через PipeWire SPA Format.

Это важно: downstream caps определяют, выберет PipeWire DMA-BUF или MemFd.
[`pipewiresrc`](https://gitlab.freedesktop.org/pipewire/pipewire/-/blob/3d520f1d879482d0bb590a353e891fd145f68954/src/gst/gstpipewiresrc.c#L1106)
пересекает caps peer-а с форматами PipeWire, получает фиксированный `SPA_PARAM_Format` и
ставит эти caps на src pad. Современный default `always-copy` — `false`; свойство уже
deprecated. Текущее `always-copy=true` принудительно уничтожает преимущество buffer sharing.

### 1.2. Рекомендуемая строка: DMA-BUF остаётся на GPU

Сначала на `castiel-pc` надо проверить, что `gst-inspect-1.0 nvh264enc` показывает sink caps
`video/x-raw(memory:GLMemory)` и что доступны `glupload`/`glcolorconvert`. Официальные pad
templates это поддерживают: [`glupload`](https://gstreamer.freedesktop.org/documentation/opengl/glupload.html)
принимает `memory:DMABuf,format=DMA_DRM`, `glcolorconvert` конвертирует GL textures, а
[`nvh264enc`](https://gstreamer.freedesktop.org/documentation/nvcodec/nvh264enc.html) принимает
NV12 в `GLMemory`.

Для текущего helper-а, который знает только node ID:

```bash
NODE=123
gst-launch-1.0 -q \
  pipewiresrc path="$NODE" always-copy=false ! \
  queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
  glupload ! glcolorconvert ! \
  'video/x-raw(memory:GLMemory),format=NV12' ! \
  nvh264enc name=enc preset=p1 tune=ultra-low-latency \
    rc-mode=cbr bitrate=8000 gop-size=60 bframes=0 rc-lookahead=0 \
    zerolatency=true repeat-sequence-header=true aud=true ! \
  h264parse config-interval=-1 ! \
  'video/x-h264,stream-format=byte-stream,alignment=au' ! \
  fdsink fd=1 sync=false async=false
```

Production-вариант должен получить FD из `OpenPipeWireRemote`, унаследовать его, например,
как fd 3, и при portal v6 предпочесть serial:

```text
pipewiresrc fd=3 target-object="$PIPEWIRE_SERIAL" always-copy=false
```

До feature-detection v6 остаётся `fd=3 path="$NODE"`. Спецификация
[`ScreenCast.OpenPipeWireRemote`](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html#org.freedesktop.portal.ScreenCast.OpenPipeWireRemote)
говорит, что этот FD открывает ограниченный PipeWire remote, где видны только узлы сеанса.

Разбор звеньев:

| Звено | Зачем оно здесь | Копирование |
|---|---|---|
| `pipewiresrc always-copy=false` | Согласовать PipeWire buffers без принудительного memcpy. | DMA-BUF может пройти как FD; MemFd остаётся fallback. |
| `queue ... leaky=downstream` | Ограничить raw backlog максимум двумя кадрами. Raw кадр можно безопасно выбросить до predictive encoder. | Queue не трогает пиксели. |
| `glupload` | Импортировать DMA-BUF через EGL/GL; официальные caps принимают `DMA_DRM` и modifiers. | Обычно импорт без CPU copy; зависит от совместимости modifier/драйвера. |
| `glcolorconvert` | BGRA/BGRx → NV12 shader-ом на GPU. | GPU operation, без `videoconvert` на CPU. |
| `GLMemory/NV12` | Зафиксировать только формат NVENC, не принуждая ни размер, ни framerate. | Caps filter сам не копирует. |
| `nvh264enc` | NVENC H.264. Он умеет GLMemory; возможен внутренний GL→CUDA GPU copy. | Нет возврата полного кадра на CPU. |
| `h264parse ... byte-stream,alignment=au` | Гарантировать Annex-B start codes и AU-aligned H.264; `config-interval=-1` добавляет SPS/PPS на IDR. | Копирование уже маленького compressed stream допустимо. |
| `fdsink sync=false` | Немедленно отдавать Annex-B в stdout, не создавать дополнительный clock wait. | Только compressed bytes. |

Это **minimum CPU-copy**, а не обещание буквального end-to-end zero-copy: KWin всё равно
рисует screencast surface, а реализация `nvh264enc` при GL interop может скопировать texture в
CUDA resource на самой GPU. Для RTX 3060 это существенно дешевле текущего readback + CPU
colorspace + CPU scale + upload.

В точной `gst-launch` строке намеренно нет `framerate=30/1`. На живом portal-
источнике попытка навязать caps range сразу после `pipewiresrc` закончилась
`not-negotiated`, а `videorate` на damage-driven stream держал кадр и добавлял около секунды
задержки. Эта строка кодирует каждый пришедший кадр; ниже, в §3.4, описан
неблокирующий limiter для production helper-а. Чистый `gst-launch` не даёт здесь
одновременно надёжный runtime limiter и управляемую адаптацию.

### 1.3. Fallback: одна host→CUDA загрузка

Если GLMemory отсутствует в фактических caps `nvh264enc` или NVIDIA EGL не импортирует modifier,
использовать:

```bash
NODE=123
gst-launch-1.0 -q \
  pipewiresrc path="$NODE" always-copy=false ! \
  queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
  cudaupload ! cudaconvert ! \
  'video/x-raw(memory:CUDAMemory),format=NV12' ! \
  nvh264enc name=enc preset=p1 tune=ultra-low-latency \
    rc-mode=cbr bitrate=8000 gop-size=60 bframes=0 rc-lookahead=0 \
    zerolatency=true repeat-sequence-header=true aud=true ! \
  h264parse config-interval=-1 ! \
  'video/x-h264,stream-format=byte-stream,alignment=au' ! \
  fdsink fd=1 sync=false async=false
```

Почему это fallback, а не основной DMA-BUF путь:

- официальный sink template
  [`cudaupload`](https://gstreamer.freedesktop.org/documentation/nvcodec/cudaupload.html)
  перечисляет SystemMemory, GLMemory, D3D11Memory и CUDAMemory, но **не DMABuf**;
- поэтому `pipewiresrc ! cudaupload` согласует KWin-овский MemFd/system-memory fallback;
- `cudaupload` делает одну загрузку на GPU, затем
  [`cudaconvert`](https://gstreamer.freedesktop.org/documentation/nvcodec/cudaconvert.html)
  делает colorspace conversion уже в CUDA;
- `cudadownload` не нужен вообще: потребитель `nvh264enc` принимает CUDAMemory.

Ставить `videoconvert` перед `cudaupload` хуже: это возвращает дорогую обработку полного кадра
на CPU. Ставить `cudaupload` после CPU I420-конвертации функционально можно, но это не minimum
copies/CPU.

### 1.4. Как не потерять low latency

`tune=ultra-low-latency` и `zerolatency=true` — не одно и то же. В GStreamer/NVENC первый
выбирает tuning info, второй включает режим без reorder delay. Дополнительно нужны:

- `bframes=0`: никакой frame reordering;
- `rc-lookahead=0`: encoder не ждёт будущие кадры;
- `preset=p1`: самый быстрый современный preset;
- `rc-mode=cbr`: предсказуемая нагрузка канала;
- ограниченная leaky queue **до** encoder-а;
- `repeat-sequence-header=true`, `aud=true` и `h264parse config-interval=-1`: каждый IDR
  самодостаточен для WebCodecs/переподключения;
- никаких многосекундных очередей compressed AU. Текущие 64 AU в `server.go` — это до 2.1 с
  при 30 fps.

У `nvh264enc` `bitrate` измеряется в **кбит/с**, поэтому `bitrate=8000` соответствует текущему
флагу агента. `max-bitrate` в CBR игнорируется. `alignment=au` в caps описывает границы
GStreamer buffers; после `fdsink` байтовый pipe их не сохраняет, поэтому `aud=true` и уже
исправленный Annex-B splitter всё равно полезны.

### 1.5. Размеры, alignment и нечётная высота

Здесь важно не повторять миф «NVENC всегда требует width/height кратные 16»:

- опубликованный template `nvh264enc` на текущей документации даёт диапазоны width
  160…4096, height 64…4096 без step=16;
- код GStreamer опрашивает `NV_ENC_CAPS_WIDTH_MIN/HEIGHT_MIN` и округляет **нижнюю границу
  capability** до 16, но caps остаются обычным диапазоном — это не требование кратности 16
  для каждого кадра;
- Alignment есть у памяти/pitch, а не как общее правило «visible dimensions кратны 16».
  [NVENC programming guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)
  для CUDA resources предписывает выделять 2D buffer через `cuMemAllocPitch()`; в GStreamer это
  обязанность CUDA/GL allocator и resource registration, а не повод менять видимый размер.

Отдельный вопрос — 4:2:0. Выбранный NV12 имеет subsampled chroma; для H.264 4:2:0 надёжная
граница — чётные width/height. GStreamer pad template не кодирует это как `step=2`, а NVIDIA
API не обещает приложению автоматическое добавление/удаление одной строки. Поэтому политика
Argus должна быть явной:

1. если native width/height чётные — не масштабировать вообще;
2. если одна координата нечётная — на GPU pad/scale на один пиксель до ближайшего чётного
   coded size;
3. в протокол отправлять фактические coded/display dimensions из encoder caps/SPS.

Если нечётную высоту просто протолкнуть в NV12/NVENC, возможный штатный результат —
`not-negotiated`/ошибка инициализации encoder-а; в текущем Argus это проявится как «нет кадров
за 6 секунд» и переход к следующему варианту. Полагаться на неописанное driver padding нельзя.
Округлять весь монитор до 16 и тем более всегда масштабировать до 1920×1080 не требуется.

---

## 2. Родное разрешение и реальные caps

### 2.1. Что означает `streams[].size` портала

Спецификация
[`org.freedesktop.portal.ScreenCast.Start`](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html#org.freedesktop.portal.ScreenCast.Start)
явно говорит:

- `streams` содержит PipeWire node/serial и словарь свойств;
- `position` и `size` находятся в **compositor coordinate space**;
- это может быть не pixel coordinate space;
- `size` может отличаться от размера самого PipeWire stream.

При KDE fractional scaling портал вполне может сказать логические 1280×720, а PipeWire stream
нести 1920×1080. Поэтому текущий `props.get("size")` полезен для отображения/маппинга ввода,
но не является размером H.264.

KWin, напротив, для output screencast задаёт начальный PipeWire размер из
`LogicalOutput::pixelSize()` и фиксирует его для физического монитора. В
[`buildFormats`](https://invent.kde.org/plasma/kwin/-/blob/452707eb5d948e69a9e506963fc49c75ff454f6c/src/plugins/screencast/screencaststream.cpp#L762)
этот размер попадает в `SPA_FORMAT_VIDEO_size`; результат negotiation затем записывается в
`m_videoFormat.size`.

### 2.2. Что изменить в pipeline-концепции

Для native resolution raw caps в этом конвейере должны ограничивать только формат, но не
width/height и не жёстко framerate:

```text
video/x-raw(memory:GLMemory),format=NV12
```

Нельзя оставлять `videoscale` и `width=1920,height=1080`. Если нужен отдельный пользовательский
режим «ограничить разрешение», это должна быть явная quality tier, а не скрытая норма Linux.
На этом стенде caps-принуждение частоты у source уже дало `not-negotiated`, поэтому
повторять его как production-решение нельзя.

После negotiation caps будут примерно такими:

```text
video/x-raw(memory:DMABuf), format=DMA_DRM,
  drm-format=AR24:<modifier>, width=<pixel-width>, height=<pixel-height>,
  framerate=<negotiated-nominal-rate>
```

или в SHM fallback:

```text
video/x-raw, format=BGRx, width=<pixel-width>, height=<pixel-height>,
  framerate=<negotiated-nominal-rate>
```

Формат `DMA_DRM` и `drm-format=fourcc:modifier` — официальный способ GStreamer передать
непрозрачный DMA-BUF; см.
[`GStreamer DMA buffers design`](https://gstreamer.freedesktop.org/documentation/additional/design/dmabuf.html).
Значение `framerate` в fixed caps — согласованная nominal/max rate, а не доказательство,
что damage-driven source фактически присылает ровно столько буферов каждую секунду.
Фактическую cadence надо измерять по PTS/счётчику буферов.

### 2.3. Как прочитать размеры

В управляемом GStreamer приложении/helper-е:

1. дать элементам имена (`src`, `rawcaps`, `enc`, `parser`);
2. дождаться CAPS event/`notify::caps` на pad после `pipewiresrc` или на sink pad первого
   GPU-элемента;
3. вызвать
   [`gst_pad_get_current_caps()`](https://gstreamer.freedesktop.org/documentation/gstreamer/gstpad.html#gst_pad_get_current_caps)
   и разобрать их через `gst_video_info_from_caps()`;
4. отдельно прочитать caps после `h264parse`: там находятся фактические profile, level,
   width/height и stream-format;
5. слушать следующие CAPS events: hotplug, mode switch и virtual output могут изменить формат.

Pad-probe уместен как способ **наблюдать CAPS events**, но не нужен для изменения bitrate.

У `gst-launch -v` negotiated caps печатаются для диагностики, однако нельзя смешивать этот
текст с H.264 на stdout. Если оставлять black-box launch, H.264 надо отправить в отдельный FD
(`fdsink fd=3`), а stdout/stderr оставить метаданным. Лучше тот же Python/GI helper, который
нужен для runtime bitrate: `fdsink` пишет compressed stream напрямую в FD, а helper лишь
наблюдает caps и меняет свойства — без Python-копирования каждого raw frame.

### 2.4. Как передать клиенту

`hello` надо формировать, как и сейчас, **до первого binary AU**, но только после двух фактов:

- `Streamer.chosen` уже установлен;
- raw и encoded caps зафиксированы.

Рекомендуемые поля:

```json
{
  "type": "hello",
  "protocol": 2,
  "source": "pipewire-portal",
  "encoder": "nvh264enc",
  "codedWidth": 1920,
  "codedHeight": 1080,
  "displayWidth": 1920,
  "displayHeight": 1080,
  "logicalWidth": 1280,
  "logicalHeight": 720,
  "fpsNum": 30,
  "fpsDen": 1,
  "bitrateKbps": 8000,
  "codec": "<из SPS/caps>",
  "profile": "main",
  "level": "4"
}
```

`logical*` необязательны для видео, но полезны при абсолютном вводе и fractional scaling.
Текущие нормализованные координаты 0…1 уже уменьшают зависимость от этих значений.

При новых CAPS во время сеанса сервер должен отправить `stream-format` с `revision`, клиент —
`decoder.reset()`, повторную `configure()` и ожидание keyframe. Canvas уже умеет принять
`VideoFrame.displayWidth/displayHeight`; надо синхронизировать с ним metadata/UI, а timestamps
строить по реальному fps или, лучше, передавать PTS кадра.

---

## 3. Подстройка качества по одному WebSocket

### 3.1. Какие сигналы реально есть у renderer-а

| Сигнал | Что он доказывает | Чего он не доказывает |
|---|---|---|
| `VideoDecoder.decodeQueueSize` | Число pending decode requests. По [WebCodecs](https://www.w3.org/TR/webcodecs/#dom-videodecoder-decodequeuesize) оно уменьшается, когда codec implementation готов принять input. | Это не число уже отрисованных кадров и не network queue. Ноль не доказывает низкую end-to-end latency. |
| `dequeue` / `ondequeue` | Событие при уменьшении `decodeQueueSize`; удобно для sampling без busy loop. | Не является подтверждением показа кадра. |
| `VideoDecoder` output callback | Кадр реально декодирован; доступны `timestamp`, `displayWidth/Height`. | До `drawImage` и compositor presentation остаётся работа. |
| `onFrame` после `drawImage` | Renderer дошёл до отрисовки; можно считать rendered fps и main-thread stalls. | Не гарантирует, что пиксели уже физически показаны монитором. |
| WebSocket receive bytes/frames и `performance.now()` | Фактический goodput, inter-arrival gaps/jitter, пропуски sequence. | Не доступную ёмкость канала выше текущего bitrate. |
| `WebSocket.bufferedAmount` | По [WHATWG](https://websockets.spec.whatwg.org/#dom-websocket-bufferedamount) — байты, поставленные **этим endpoint через `send()`**, но ещё не переданные сети. | На клиенте почти весь traffic входящий, поэтому это не очередь сервер→клиент и не индикатор video congestion. |
| `document.visibilityState`, long tasks | Объясняет падение render fps из-за background/throttling или main thread. | Не состояние сети. |

В браузерном WebSocket нет API TCP congestion window, protocol ping/pong и серверной send
queue. Поэтому нужны собственный JSON ping/pong и server telemetry.

`optimizeForLatency: true` оставлять: WebCodecs определяет его как hint уменьшить число chunks,
которые декодер должен принять до output. Это не отменяет B-frames/lookahead в bitstream,
поэтому encoder-side параметры из пункта 1 обязательны.

### 3.2. Какие сигналы добавить на стороне агента

Агент знает то, чего не знает renderer:

- длительность `WriteMessage`;
- текущую заполненность `out`;
- число AU, отброшенных до socket write;
- bytes/frames, выданные encoder-ом;
- текущий tier и фактически применённые properties;
- sequence каждого AU и keyframe flag.

Сейчас `default` в `server.go:231-235` молча выбрасывает произвольный compressed AU. Это
опаснее, чем drop raw frame: потеря reference P-frame портит следующие delta frames до
следующего IDR. Нужны счётчик, keyframe request после потери и гораздо более короткая очередь.
Лучшее место для планового dropping — raw pad до upload/colorspace/encoder; bounded
`queue leaky=downstream` отдельно страхует от backlog.

### 3.3. Разумные ступени для 1080p screen content

Это стартовые значения для измерений, не универсальная таблица качества:

| Tier | FPS | Bitrate, кбит/с | Назначение |
|---:|---:|---:|---|
| 4 | 30 | 8000 | Текущий максимум; стабильный LAN/Tailscale. |
| 3 | 30 | 6000 | Мягкая реакция: сохранить плавность, сначала сжать сильнее. |
| 2 | 24 | 4500 | Средний канал; UI всё ещё ощущается живым. |
| 1 | 20 | 3000 | Узкий/нестабильный канал. |
| 0 | 15 | 2000 | Аварийный интерактивный минимум для текста/администрирования. |

Для 1440p/ultrawide верхние bitrate должны расти по результатам SSIM/VMAF и визуального теста;
слепое линейное умножение на число пикселей для screen content неточно из-за больших
статических областей. Разрешение в первой версии adaptation лучше оставить native: его
переключение меняет SPS/decoder configuration, тогда как bitrate/fps меняются проще.

Контроллер должен иметь hysteresis:

- окно статистики 1 с;
- быстро вниз: две подряд секунды с растущим `decodeQueueSize`, server out-queue/drop или
  rendered fps < 80% target при `visibility=visible`;
- сразу на две ступени при decode queue > 8, frame age > 250–300 мс или заметной потере AU;
- вверх только по одной ступени после 10–15 с: decode queue p95 ≤ 1, ноль server drops,
  стабильный RTT/jitter и rendered fps близок target;
- минимум 5 с между обычными изменениями;
- background renderer не должен заставлять сервер повышать/понижать tier по render fps.

`decodeQueueSize` надо анализировать как тренд/p95, а не единичное значение. Если очередь уже
неограниченно выросла, клиент может `reset()` decoder, перейти в `waitingForKeyframe` и послать
`request-keyframe`; продолжать скармливать delta frames бессмысленно.

### 3.4. Как менять bitrate без нового portal-сеанса

Официальная документация показывает `bitrate` как read/write property. Более важное
доказательство — текущий
[`gstnvh264encoder.cpp`](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/34b38971549d61b3ba39106307e13c1d27957347/subprojects/gst-plugins-bad/sys/nvcodec/gstnvh264encoder.cpp#L2003):

- properties помечены `GST_PARAM_MUTABLE_PLAYING`;
- setter `bitrate` выставляет `bitrate_updated`;
- на следующем frame `check_reconfigure()` проверяет
  `NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE`;
- при поддержке меняет `averageBitRate/maxBitRate` и вызывает NVENC Reconfigure;
- без capability делает full reconfigure **encoder-а**, а не PipeWire/portal session.

Следовательно, в GStreamer application достаточно выполнить в GLib main context:

```text
g_object_set(enc, "bitrate", new_kbps, NULL)
```

Для CBR менять только `bitrate`. **Pad-probe и `RECONFIGURE` event не нужны**: реализация
encoder-а сама видит property change в frame path. Force-key-unit не обязателен для самого
bitrate, но полезен после packet/AU loss или decoder reset; GStreamer имеет официальный
[`GstForceKeyUnit`](https://gstreamer.freedesktop.org/documentation/video/video-event.html#gst_video_event_new_upstream_force_key_unit)
event с `all_headers=true`.

Ограничение текущей архитектуры: внешний `gst-launch-1.0` не предоставляет Argus IPC для
`g_object_set`. Сигнал процессу или запись текста в stdin property не изменят. Рациональный
вариант без cgo:

1. portal Python-процесс продолжает держать session;
2. Python/GI GStreamer helper создаёт pipeline через `Gst.parse_launch`, сохраняет `enc`
   и raw pads;
3. H.264 идёт через `fdsink` напрямую в отдельный FD — Python не копирует AU;
4. control FD/stdin принимает JSON от Go (`set-quality`, `request-keyframe`);
5. metadata FD отдаёт fixed caps/errors/`quality-applied`;
6. helper меняет encoder property и target interval raw-dropper-а. Portal process и PipeWire source не
   перезапускаются.

Для fps на этом источнике основной механизм — не `videorate`, а неблокирующий raw-buffer
dropper до `glupload`/`cudaupload`. Официальный
[`GStreamer probe design`](https://gstreamer.freedesktop.org/documentation/additional/design/probes.html)
прямо определяет `GST_PAD_PROBE_DROP` как способ выбросить текущий item. Такая pad-probe смотрит PTS каждого пришедшего
буфера: первый буфер пропускает, следующие пропускает, только если
`PTS >= next_kept_pts`, а более ранние немедленно возвращает как `GST_PAD_PROBE_DROP`.
`next_kept_pts` сдвигается на `1 second / target_fps`; при смене tier helper меняет только
этот interval. Такой probe не map-ит и не копирует pixels, не ждёт следующий кадр,
а на редко меняющемся damage-driven screen пропустит первый доступный новый кадр.

Официальный [`videorate`](https://gstreamer.freedesktop.org/documentation/videorate/index.html)
сам по себе умеет drop-only/счётчики и остаётся в том же portal-сеансе, но на живом
damage-driven потоке он уже привёл к удержанию кадра и примерно секундной задержке.
Поэтому для Argus он не рекомендован без отдельного стендового опровержения этой регрессии.

Не стоит на каждом tier менять `gop-size`: в GStreamer это init-level property и может вызвать
full encoder reconfigure. Сохранять восстановление ≤2 с удобнее периодическим
force-key-unit по времени.

### 3.5. Протокол поверх того же WebSocket

Транспорт остаётся один: text JSON для control/telemetry, binary для AU. Нужен protocol bump,
потому что к binary header полезно добавить sequence и PTS:

```text
byte 0      flags: bit0=key
bytes 1..4  uint32 sequence, big-endian
bytes 5..12 uint64 capture/PTS microseconds, big-endian
bytes 13..  Annex-B AU
```

Это позволяет отличить network/server drop, считать inter-arrival и больше не генерировать
фиктивные 60-fps timestamps в renderer-е.

Client → server:

```json
{"type":"ping","id":17,"clientMonoUs":123456789}
{"type":"stats","windowMs":1000,"lastSeq":9012,"rxBytes":612345,"rxFrames":29,"decodedFrames":29,"renderedFrames":28,"decodeQueueNow":1,"decodeQueueP95":2,"decodeQueueMax":3,"visible":true}
{"type":"quality-mode","mode":"auto","maxTier":4}
{"type":"quality-mode","mode":"manual","tier":2}
{"type":"request-keyframe","reason":"decoder-reset","afterSeq":9012}
```

Server → client:

```json
{"type":"pong","id":17,"clientMonoUs":123456789,"serverMonoUs":987654321}
{"type":"quality-applied","revision":7,"tier":2,"fps":24,"bitrateKbps":4500,"effectiveFromSeq":9020,"reason":"sender-queue"}
{"type":"sender-stats","windowMs":1000,"encodedFrames":24,"sentFrames":24,"droppedRaw":6,"droppedAU":0,"queueMax":1}
{"type":"stream-format","revision":3,"codedWidth":1920,"codedHeight":1080,"displayWidth":1920,"displayHeight":1080,"fpsNum":24,"fpsDen":1,"codec":"avc1....","requiresKeyframe":true}
```

Решение tier лучше принимать на сервере: только он видит send queue и только он может
применить GStreamer property. Клиент сообщает наблюдения и ручной ceiling. `revision` и
`effectiveFromSeq` нужны, потому что все сообщения идут по одному упорядоченному WebSocket и
можно точно связать новую настройку с видео.

---

## 4. KDE Plasma 6: можно ли без portal-диалога

### 4.1. `org.kde.KWin.ScreenCasting`

В актуальном KWin Plasma 6 D-Bus интерфейса с таким именем нет. В current source нет ни
service, ни introspection XML `org.kde.KWin.ScreenCasting`. Актуальный непрерывный путь —
KDE-specific Wayland protocol
[`zkde_screencast_unstable_v1`](https://invent.kde.org/libraries/plasma-wayland-protocols/-/blob/c421474708c26a409817c255e1c43939351444d8/src/protocols/zkde-screencast-unstable-v1.xml).

Его собственная документация говорит буквально: это implementation detail desktop
environment, обычные клиенты не должны его использовать, backward-incompatible изменения
могут появляться без major-version bump. Он умеет output/window/region/virtual output и
возвращает PipeWire node/serial.

Модель разрешений KWin на срезе 2026-07-29 видна прямо в
[`KWinDisplay::allowInterface()`](https://invent.kde.org/plasma/kwin/-/blob/452707eb5d948e69a9e506963fc49c75ff454f6c/src/wayland_server.cpp#L129):

- `zkde_screencast_unstable_v1` находится в списке restricted Wayland interfaces;
- sandboxed клиенту KWin его не показывает;
- non-sandboxed клиенту пользовательского Wayland-сеанса текущий `allowInterface()` его
  разрешает;
- KDE-приложения дополнительно декларируют
  `X-KDE-Wayland-Interfaces=...zkde_screencast_unstable_v1` в desktop file;
- Polkit или chooser на каждый direct protocol request нет.

Итого: **технически unsandboxed локальный процесс того же пользователя может получить
непрерывный stream без portal-диалога**. Но это приватный KDE bypass, а не portable/supported
API для Argus. Кроме привязки к Plasma он требует Wayland protocol client; текущий Go агент
с ограничением «без cgo» его не реализует.
Если критерий — **поддерживаемый сторонний API для continuous capture**, то прямой ответ:
**без portal-диалога на первом разрешении нельзя**; `restore_token` минимизирует лишь
последующее участие человека.

### 4.2. `org.kde.KWin.ScreenShot2`

Этот D-Bus интерфейс в Plasma 6 существует: актуальный
[`org.kde.KWin.ScreenShot2.xml`](https://invent.kde.org/plasma/kwin/-/blob/452707eb5d948e69a9e506963fc49c75ff454f6c/src/plugins/screenshot/org.kde.KWin.ScreenShot2.xml)
описывает API version 5 для window/area/screen/workspace, raw pipe, width/height/stride и
`native-resolution`.

С июля 2024 KWin удалил проверку `X-KDE-DBUS-Restricted-Interfaces`: в
[`0ea31ae`](https://invent.kde.org/plasma/kwin/-/commit/0ea31ae72eb052cb9c9cc508318fc3f0f329ed53)
разработчик прямо пишет, что desktop files пользователь может изменить/override, поэтому
проверка не давала реальной security; лучшая доступная защита — sandbox. В текущей реализации
нет portal-диалога и permission check для каждого Capture call.

Это означает «скриншот без диалога», но **не нормальный видеопоток**: каждый вызов создаёт
полный QImage/raw pipe и делает one-shot capture. Цикл на 30 fps даст лишние allocations,
GPU readback/CPU copies и D-Bus overhead, не использует PipeWire buffer sharing/damage как
stream. Для Argus это диагностика/thumbnail, не backend трансляции.

### 4.3. Что используют KDE-приложения

- **Spectacle, снимки:** вызывает `org.kde.KWin.ScreenShot2`; это видно в
  [`ImagePlatformKWin.cpp`](https://invent.kde.org/plasma/spectacle/-/blob/e7cd33e2136f35fa2af5644732f98fb326d91ce0/src/Platforms/ImagePlatformKWin.cpp#L40).
- **Spectacle, запись видео:** его
  [`screencasting.cpp`](https://invent.kde.org/plasma/spectacle/-/blob/e7cd33e2136f35fa2af5644732f98fb326d91ce0/src/Platforms/screencasting.cpp#L20)
  использует `zkde_screencast_unstable_v1` + PipeWire; desktop entry декларирует этот Wayland interface.
- **KRdp:** создаёт `QWaylandClientExtensionTemplate` для
  `zkde_screencast_unstable_v1`, получает PipeWire node/serial; desktop entry KRdp декларирует
  и screencast, и fake input. См.
  [`screencasting.cpp`](https://invent.kde.org/plasma/krdp/-/blob/c0cbeaca32b4c0535fd0bbd9ce561db5ed50fb78/src/screencasting.cpp#L81).
- **KRfb:**
  [`framebuffers/pipewire/screencasting.cpp`](https://invent.kde.org/network/krfb/-/blob/d90de088925651531018dd9e6ca441bdedb5b70b/framebuffers/pipewire/screencasting.cpp#L20)
  содержит клиента того же `zkde_screencast_unstable_v1`; основной legacy desktop sharing также имеет
  отдельный KDE remote-access protocol.
- **xdg-desktop-portal-kde:** после portal policy/chooser сам обращается к тому же приватному
  KWin Wayland protocol. То есть portal не создаёт кадры; он является пользовательской
  policy-границей перед KWin/PipeWire.

### 4.4. Как свести участие человека к первому запуску

Официальный и устойчивый вариант для Argus:

1. `SelectSources` с `persist_mode=2` — permission сохраняется до явного отзыва;
2. первый `Start` обычно показывает chooser; пользователь выбирает монитор и разрешает
   восстановление;
3. сохранить returned `restore_token` с mode 0600;
4. на следующем `SelectSources` передать token;
5. после каждого успешного `Start` **атомарно заменить старый token новым**.

Почему пункт 5 обязателен: по
[`ScreenCast` v6](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html#org.freedesktop.portal.ScreenCast.SelectSources)
restore token одноразовый и инвалидируется при использовании. Если source исчез, permission
отозван или restore data больше нельзя сопоставить, token игнорируется и portal снова
показывает обычный chooser.

KDE backend это реально реализует: в актуальном
[`screencast.cpp`](https://invent.kde.org/plasma/xdg-desktop-portal-kde/-/blob/4d45072cf64fa1a2be026aedda95eeaab877be5b/src/screencast.cpp#L327)
он проверяет restore data, сопоставляет output/window/region и при валидном результате идёт
сразу к `continueStartAfterDialog`; при невалидном создаёт `ScreenChooserDialog`.

Текущий helper почти соблюдает контракт: `persist_mode=2`, token 0600 и перезапись нового
token есть. Но строка `REUSED=да`, основанная лишь на наличии старого файла, недостоверна:
portal мог проигнорировать token и показать chooser. Истиной является факт успешного restore,
который backend/public portal должен вернуть или который можно вывести только косвенно по
отсутствию chooser; наличие файла этого не доказывает.

## Рекомендуемый порядок реализации

1. Не переделывать уже появившийся WIP-каскад `nvh264enc → vah264enc → x264`, а исправить его
   первый NVENC-путь: убрать `always-copy=true`, CPU `videoconvert` и незаметное приведение
   к 1920×1080.
2. Сначала поднять CUDA fallback `cudaupload ! cudaconvert ! CUDAMemory/NV12 ! nvh264enc`,
   затем на том же стенде проверить DMA-BUF/GLMemory и выбрать его первым; CUDA-system path
   оставить fallback по факту первого AU за 6 с.
3. Заменить black-box `gst-launch` управляемым helper-ом, не меняя portal session и no-cgo
   Go бинарь.
4. Добавить в helper неблокирующий PTS-dropper до GPU upload; не возвращать
   `framerate=30/1` в source caps без повторной стендовой проверки.
5. Читать negotiated caps и SPS; для dimensions использовать pixel caps, а не portal logical `size`,
   затем исправить `hello`/codec/timestamps.
6. Добавить sequence/PTS, stats/ping/quality protocol и только затем включать автомат tiering.
7. Исправить portal transport: `OpenPipeWireRemote`; feature-detect v6 serial и перейти с
   `path=node-id` на `target-object=pipewire-serial`.

## ЧЕГО Я НЕ ПРОВЕРИЛ

- Не запускал предложенные pipeline на `castiel-pc` и не снимал CPU/GPU utilization, latency,
  frame drop и negotiated caps. Это главное оставшееся подтверждение.
- Не видел полный `gst-inspect-1.0 nvh264enc/glupload/glcolorconvert/cudaupload/cudaconvert`
  именно на `castiel-pc`; наличие элементов известно из условия, но GLMemory pad features и
  enum/property set конкретной версии не сняты.
- Не проверил импорт конкретного KWin DRM modifier через NVIDIA EGL 610.43.02. Поэтому
  DMA-BUF→GL путь имеет высокую архитектурную, но пока среднюю стендовую уверенность; CUDA
  MemFd fallback обязателен.
- Не запросил на RTX 3060 `NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE` и не менял `bitrate` во
  время живого encode. Upstream GStreamer поддерживает это, но фактический device capability
  остаётся непроверенным.
- Не воспроизводил odd width/height на этом driver/plugin. В отчёте дана безопасная политика
  «сделать 4:2:0 coded size чётным», а не утверждение о точном тексте ошибки драйвера.
- Не сверял установленные на `castiel-pc` версии KWin/xdg-desktop-portal-kde с master-срезом
  2026-07-29. Особенно не проверено наличие public ScreenCast v6 `pipewire-serial`; актуальный
  KDE backend source на этом срезе всё ещё объявляет backend interface version 5.
- Не проверял, как конкретная Electron/Chromium сборка Argus выбирает hardware H.264 decoder,
  и не измерял семантику `optimizeForLatency` на ней.
- Не проводил визуальный A/B тест предложенных bitrate tiers на тексте, прокрутке и видео;
  числа являются стартовой лестницей для измерений, не готовым quality contract.
- Не реализовывал и не тестировал GStreamer Python/GI control helper, CAPS watcher или новый
  WebSocket protocol. По задаче код репозитория не изменялся.
