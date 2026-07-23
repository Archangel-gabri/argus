# Argus: экран ПК + управление внутри окна (Electron, hardened) — сравнение OSS-стеков (2026-07)

**Кейс:** Argus (Electron, contextIsolation/sandbox, CSP `script-src 'self'`, webviewTag off) уже имеет SSH к ПК владельца.
Нужно: **видео экрана + мышь/клава внутри окна Argus**, без звука, авто-provision агента по SSH, транспорт Tailscale (100.x, ничего в WAN, дом за CGNAT).
Цели: **Windows 11 Pro** И **Arch + KDE Plasma 6 Wayland**, GPU **RTX 3060 (NVENC есть)**. Argus крутится на ноуте владельца (Linux/Arch KDE), цель — десктоп «Castiel» (dual-boot).

> **Главный фильтр кейса:** нужно смотреть/управлять **РЕАЛЬНОЙ залогиненной сессией** владельца, а не headless-виртуалкой.
> Это сразу режет headless/контейнерные стеки (Selkies, KasmVNC): они поднимают собственный Xvfb/компоцитор, а не цепляются к живой сессии.

---

## 1. Таблица сравнения (7 критериев)

Легенда: ✅ хорошо · ⚠️ с оговорками · ❌ дисквалификатор для кейса

| Кандидат | 1. Авто-provision по SSH | 2. Встраивание в hardened Electron | 3. Ввод (мышь/клава) Wayland+Win | 4. Захват экрана + NVENC | 5. Латентность/Tailscale | 6. Лицензия | 7. Зрелость/отзывы | Вердикт |
|---|---|---|---|---|---|---|---|---|
| **Apache Guacamole** (guacd + guacamole-lite + guacamole-common-js) поверх RDP | ✅ Win: RDP уже встроен (только reg-твик по SSH, 0 установки). Arch: `pacman krdp` + user-сервис | ✅ **guacamole-common-js — чистый JS canvas, вендорится локально** под `script-src 'self'`; guacd+guacamole-lite в main-процессе Argus (он на Linux-ноуте) | ✅ **инъекция делает сам RDP-сервер** в реальную сессию (Win — нативно; KDE KRdp — через RemoteDesktop-портал внутри себя). Нам НЕ надо писать uinput/portal-код | ⚠️ RDP-кодек (AVC444, аппаратный на Win). NVENC как таковой не задействован; для «смотреть/управлять» хватает | ✅ RDP лёгкий по битрейту → нормально даже через DERP-релей | ✅ Apache-2.0; guacamole-lite MIT | ✅ Эталонный clientless-RDP-шлюз, годы в проде | **✅ ТОП для MVP** |
| **Нативный Windows RDP + KDE KRdp** (это бэкенды для строки выше) | ✅ Win — встроен; Arch — `krdp` пакет | — (бэкенд, клиент отдельно) | ✅ Win нативно; ⚠️ **KRdp на NVIDIA/Wayland ломает аппаратный энкодер** (см. §3) | ⚠️ Win аппаратный; **KRdp «No encoder could be created» на NVIDIA → чёрный экран/софт-фолбэк** | ✅ | ✅ MS EULA (свой ПК) / KRdp GPL | ✅ Win зрелый; ⚠️ KRdp+NVIDIA сырой | ✅ Win / ⚠️ KDE |
| **IronRDP-web** (WASM RDP-клиент, Devolutions) | как RDP выше | ✅ WASM-клиент вендорится; **нужен маленький WS→TCP шим** (Cloudflare/Devolutions Gateway; можно свой в main-процессе) | ✅ через RDP | ⚠️ как RDP | ✅ | Apache-2.0/MIT | ⚠️ Web-часть в проде у Cloudflare Access; как переиспользуемая либа сырее Guacamole | ⚠️/✅ альтернатива клиенту Guacamole |
| **MeshCentral** (+MeshAgent) | ✅ **лучший авто-деплой агента** (одна команда/служба) Win/Linux | ⚠️ его web-KVM — целое приложение; в Electron грузить как удалённый origin (не вендорится под `'self'`) | ✅ Win отлично; ❌/⚠️ **Linux KVM исторически X11; на Wayland слабо/не пашет** | ⚠️ свой энкодер, без NVENC | ✅ (можно включить WebRTC) | Apache-2.0 | ✅ зрелый у MSP; ⚠️ Wayland-KVM больное место | ✅ Win-only / ❌ KDE Wayland |
| **Sunshine + moonlight-web** | ⚠️ Win: winget `LizardByte.Sunshine`; Arch: AUR/`pacman`. Плюс поднять moonlight-web (unofficial). Пейринг по **PIN** автоматизировать неудобно | ⚠️ moonlight-web — удалённый webapp (WebRTC); грузить в изолированный WebContentsView со своим CSP, не вендорится под `'self'` | ✅ **Linux — uinput (kernel-level, работает в реальной Wayland-сессии!)**; Win — нативно | ✅ **Настоящий NVENC на обеих ОС; KDE — KWin-screencast захват (обходит проблему KRdp!)** | ✅ низкая, но **высокий FPS через DERP-релей = узкое место (CGNAT)** | GPL-3 (Sunshine) | ⚠️ Sunshine зрелый; **moonlight-web молодой/unofficial**, game-stream-семантика | ⚠️/✅ апгрейд качества (фаза 3) |
| **Selkies-GStreamer** | ⚠️ ориентирован на Docker/K8s | ✅ WebRTC HTML5 | своя инъекция | ✅ NVENC, Wayland-режим по умолчанию (Webtop 4.1) | ✅ | MPL/Apache | ✅ но **для headless/контейнерных десктопов** | ❌ не цепляется к реальной сессии |
| **KasmVNC** | ⚠️ контейнер | ✅ свой web-клиент | своя инъекция | ⚠️ WebP/H.264, без явного NVENC | ✅ | Apache-2.0 (модиф.) | ✅ но **виртуальный дисплей, не физ. сессия** | ❌ то же, headless |
| **noVNC + VNC-сервер** (TigerVNC/wayvnc/krfb/UltraVNC) | ⚠️ Win — доп. установка VNC; Arch — **wayvnc = только wlroots, НЕ KWin**; **krfb требует ручного подтверждения** каждого коннекта | ✅ noVNC — чистый JS canvas, вендорится идеально | ⚠️ krfb — портал; wayvnc не для KDE | ❌ без NVENC, лаг | ✅ (мало битрейта) | MPL/GPL | ✅ noVNC зрелый, но VNC на KDE-Wayland болезненный | ⚠️ универсальный, но худший фолбэк |
| **RustDesk (web-клиент)** | ✅ бинарь Win/Linux | ❌ | ✅ Wayland (portal+uinput), Win нативно | ⚠️ | — | **❌ self-host web-клиента ПЛАТНЫЙ** (мин. 10-user/300-device, генератор клиента за пейволом); native-клиент AGPL, но не встраивается | ✅ native зрелый | ❌ для встраивания (пейвол + AGPL) |

---

## 2. Топ-1 рекомендация для MVP

### **Apache Guacamole (guacd + guacamole-lite + guacamole-common-js) поверх RDP; сервера — встроенный Windows RDP и KDE KRdp; всё через Tailscale.**

**Почему именно это, по критериям кейса:**

1. **Windows-first без установки вообще.** RDP уже в Windows 11 Pro. Авто-provision по SSH = один reg-твик (`fDenyTSConnections=0` + firewall-rule), никакого бинаря на цель тащить не надо. Для «Castiel часто под Windows» — идеально.
   - Источник: https://gist.github.com/asheroto/530748b3bf0528cc4805d652b612f81f · https://www.helpwire.app/blog/powershell-enable-remote-desktop/
2. **Единственный кандидат, который одновременно:** (а) даёт **чисто-JS canvas-клиент** (`guacamole-common-js`), который вендрится локально и живёт под строгим `script-src 'self'`; (б) говорит по **протоколу, который обе ОС отдают НАТИВНО** (Windows RDP + KDE KRdp). Один клиент — два родных сервера.
   - Источник: https://www.npmjs.com/package/guacamole-common-js · https://github.com/vadimpronin/guacamole-lite · https://guacamole.apache.org/doc/gug/writing-you-own-guacamole-app.html
3. **Ввод (мышь/клава) даёт сам RDP-сервер** — нам НЕ нужно трогать libei/uinput/RemoteDesktop-портал руками (главная Wayland-засада снята на стороне KRdp).
4. **Управляем РЕАЛЬНОЙ сессией.** Win RDP отдаёт свою сессию (консоль лочится — для удалённого владельца это ок и приватнее); KRdp цепляется к **живой Plasma-Wayland-сессии** через портал.
   - Источник (KRdp = живая сессия через FreeDesktop RemoteDesktop portal): https://github.com/KDE/krdp · https://www.linuxjournal.com/content/kde-plasma-6-wayland-payoff-years-plumbing
5. **guacd крутится на стороне Argus (Linux-ноут)** — там, где Guacamole-стек ставится тривиально (`pacman`/docker), а не на цели. Renderer рисует canvas, main-процесс держит `guacamole-lite` WS-мост на `127.0.0.1`.
6. **RDP по битрейту лёгкий** → приемлемо даже через DERP-релей (CGNAT-реальность владельца), в отличие от high-fps NVENC-потока.

> Если нужна **максимальная плавность (игровое качество)** — это отдельная «фаза 3»: **Sunshine + moonlight-web** (настоящий NVENC на обеих ОС, KWin-screencast обходит проблему KRdp). Но для «смотреть экран + администрировать» RDP+Guacamole проще, зрелее и лучше встраивается.

---

## 3. Честный красный флаг: управление/захват под KDE Plasma 6 Wayland в 2026

**Что реально работает:**
- **Инъекция ввода под Wayland решена на уровне серверов, не нами.** Два надёжных пути в 2026:
  - **KRdp** (встроен в Plasma 6.1+) инжектит ввод и захватывает экран через **FreeDesktop RemoteDesktop-портал + KPipeWire + FreeRDP** — цепляется к живой сессии, **без per-connection подтверждения** (в отличие от krfb/VNC). Ставится и включается по SSH:
    `sudo pacman -Syu krdp` → `systemctl --user enable --now app-org.kde.krdpserver.service`.
    Источник: https://medium.com/@ritonvain/the-quest-for-perfect-remote-desktop-on-arch-linux-kde-6-2-444eb83b989a · https://github.com/KDE/krdp
  - **Sunshine** инжектит ввод через **kernel `uinput`** (виртуальные устройства /dev/uinput) — работает в реальной Wayland-сессии независимо от компоцитора, нужны группа `input` + udev-правило.
    Источник: https://www.reddit.com/r/MoonlightStreaming/comments/1tpid3i/fixing_mouse_and_keyboard_input_not_passing/
  - **RustDesk** тоже умеет (portal-capture + uinput), Wayland-поддержка у него сильнейшая — но web-клиент за пейволом (см. таблицу).
    Источник: https://rustdesk.com/blog/rustdesk-for-linux

**Что РЕАЛЬНО ломается (главный риск для Linux-цели):**
- **KRdp + NVIDIA на Wayland = аппаратный энкодер часто не создаётся.** Живой лог с почти нашей конфигурацией (Arch, KDE 6.5, NVIDIA) показывает:
  `VAAPI: VA-API NVDEC driver ... Forcing encoder to "SoftwareEncoder" ... No encoder could be created` → **чёрный экран при коннекте**.
  То есть на RTX 3060 KRdp может свалиться в софт-энкод (грев CPU, лаги) или вовсе не отдать картинку.
  Источник: https://discuss.kde.org/t/krdp-help-blank-screen-on-connect/41952 · доп. поломка после апдейта: https://forum.manjaro.org/t/krdp-server-no-longer-starts-after-2025-02-17-update-testing-branch/174382
- **wayvnc — только wlroots, НЕ KWin** → на KDE не работает; **krfb (VNC)** требует ручного «Разрешить удалённое управление» на каждый коннект → **несовместимо с unattended auto-provision**.
  Источник: https://discuss.kde.org/t/krfb-on-wayland-have-to-confirm-remote-control-requested/2650
- **MeshCentral** на Linux KVM исторически X11-only; под Wayland пусто/сломано.
  Источник: https://github.com/Ylianst/MeshCentral/discussions/6316

**Вывод по Wayland:** Windows-сторона беспроблемна. На **Linux/KDE держи Sunshine (NVENC+uinput+KWin-screencast) как основной или запасной путь именно из-за фрагильности KRdp на NVIDIA.** Не завязывайся на KRdp как на единственный вариант для RTX 3060 — сначала POC-проверь, отдаёт ли он аппаратную картинку на конкретной машине.

---

## 4. Поэтапный план + точные команды

### Фаза 0 — POC на ОДНОМ ПК (докажи риски дёшево)
- **Windows-цель:** по SSH включить RDP, из ноута подключиться нативным клиентом (Remmina/FreeRDP) по Tailscale-IP — убедиться, что картинка+ввод идут.
  ```powershell
  # выполнить на цели по SSH (PowerShell как admin)
  Set-ItemProperty -Path "HKLM:\System\CurrentControlSet\Control\Terminal Server" -Name fDenyTSConnections -Value 0
  Set-ItemProperty -Path "HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" -Name UserAuthentication -Value 1
  Enable-NetFirewallRule -DisplayGroup "Remote Desktop"
  # ограничить RDP только tailnet-подсетью (ничего в WAN):
  New-NetFirewallRule -DisplayName "RDP tailnet" -Direction Inbound -Protocol TCP -LocalPort 3389 -RemoteAddress 100.64.0.0/10 -Action Allow
  ```
- **Arch/KDE-цель (ГЛАВНАЯ проверка риска §3):** по SSH поставить и включить KRdp, подключиться, **проверить journalctl — аппаратный ли энкодер**:
  ```bash
  sudo pacman -S --needed krdp
  # креды/порт: kwriteconfig6 --file krdpserverrc ... (или через System Settings один раз)
  systemctl --user enable --now app-org.kde.krdpserver.service
  journalctl --user -u app-org.kde.krdpserver.service -f   # ищем "No encoder could be created"
  ```
  Если чёрный экран/софт-энкод → сразу тестируй Sunshine на этой же машине:
  ```bash
  # Arch
  yay -S sunshine   # или pacman, если в репо; либо flatpak dev.lizardbyte.app.Sunshine
  sudo usermod -aG input $USER          # доступ к uinput для ввода
  systemctl --user enable --now sunshine
  # захват KDE-Wayland: Sunshine автодетектит KWin-screencast / NVENC(CUDA)
  ```
  Источник по Sunshine-захвату (KWin screencast + NVENC на Win/Linux): https://github.com/lizardbyte/sunshine · https://www.gamingonlinux.com/2026/05/sunshine-game-streaming-tool-adds-vulkan-encoding-plus-xdg-pipewire-and-kwin-direct-screencast-capture/

### Фаза 1 — MVP (встраивание в Argus, Windows-first)
- **Клиент:** вендорить `guacamole-common-js` в renderer (canvas + перехват мыши/клавы).
- **Мост:** в main-процессе Argus поднять `guacamole-lite` (Node WS-сервер) на `127.0.0.1:<port>`, он говорит с локальным **guacd**.
  ```bash
  # на ноуте (Argus-сторона, Linux) — guacd ставится тривиально
  sudo pacman -S guacamole-server   # или docker run -d guacamole/guacd
  npm i guacamole-lite guacamole-common-js
  ```
- guacamole-lite открывает RDP-коннект **через Tailscale** на `100.x:3389` (Win RDP или KRdp). Пароль сессии — из secrets/vault, не в git.
- **Windows авто-provision** — тот же PowerShell-скрипт из Фазы 0, гоняется Argus'ом по существующему SSH при первом «Подключить экран».
- Управление сессией (start/stop guacd-tunnel, статус) — через IPC main↔renderer.

### Фаза 2 — Linux-цель в проде + фолбэк
- Добавить KRdp-провижн по SSH (pacman + kwriteconfig + user-сервис) как «RDP-путь» — единый клиент Guacamole.
- **Заложить авто-фолбэк на Sunshine+moonlight-web**, если KRdp на RTX 3060 не отдаёт аппаратную картинку (детект по journalctl/таймауту).
- Sunshine-провижн по SSH: установка + `usermod -aG input` + udev-правило `/dev/uinput` + user-сервис.

### Фаза 3 — качество/плавность (опционально)
- Перевести обе ОС на **Sunshine (NVENC) + WebRTC-клиент** для игрового FPS; moonlight-web грузить в **изолированный WebContentsView** (свой origin/partition, свой CSP), не вендоря под `'self'`.
- Помнить про CGNAT: high-fps через DERP-релей — узкое место; по возможности добиваться direct-коннекта Tailscale (или свой DERP на HubVPN-ноде — уже есть в заметках владельца).

### Правки CSP / webPreferences Argus

**webPreferences (не ослаблять hardening):**
```js
{ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false }
```

**Вариант A — Guacamole/noVNC/IronRDP-web (вендоренный JS/WASM-клиент, локальный WS) — рекомендуется:**
- CSP renderer: оставить `script-src 'self'`; добавить в `connect-src` локальный сокет моста:
  ```
  default-src 'self';
  img-src 'self' data: https:;
  script-src 'self';
  connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:*;
  ```
- `guacd`/`guacamole-lite` живут на loopback → в WAN/Tailscale наружу торчит только RDP-порт цели, а renderer вообще не ходит в 100.x напрямую. Никакого `frame-src`/удалённых скриптов. Для IronRDP-web добавить `wasm-unsafe-eval` в `script-src` (WASM), либо инстанцировать WASM в main.

**Вариант B — удалённый webapp (Sunshine/moonlight-web/Selkies) в изолированном WebContentsView:**
- Грузить как top-level navigation в отдельный `WebContentsView` со своим `partition` и `sandbox:true`; его скрипты исполняются под ЕГО origin (Tailscale-хост), а не под origin Argus.
- CSP этого view (или заголовки от moonlight-web): `connect-src 'self' https://<ts-host>:* wss://<ts-host>:*` + для WebRTC (CSP3 регулирует ICE через `connect-src`) добавить host-кандидат `100.x`; `media-src blob:` для video/MSE.
- Плюс Tailscale-транспорт: host-ICE-кандидаты по 100.x, **без внешних STUN/TURN** — точно попадает в «ничего в WAN».

---

## 5. Источники (ключевые)

- Guacamole embed: https://www.npmjs.com/package/guacamole-common-js · https://github.com/vadimpronin/guacamole-lite · https://guacamole.apache.org/doc/gug/writing-you-own-guacamole-app.html
- KDE KRdp (portal+KPipeWire+FreeRDP, живая сессия): https://github.com/KDE/krdp · https://www.linuxjournal.com/content/kde-plasma-6-wayland-payoff-years-plumbing · включение: https://medium.com/@ritonvain/the-quest-for-perfect-remote-desktop-on-arch-linux-kde-6-2-444eb83b989a
- **KRdp+NVIDIA энкодер ломается (красный флаг):** https://discuss.kde.org/t/krdp-help-blank-screen-on-connect/41952 · https://forum.manjaro.org/t/krdp-server-no-longer-starts-after-2025-02-17-update-testing-branch/174382
- krfb требует ручного подтверждения (не unattended): https://discuss.kde.org/t/krfb-on-wayland-have-to-confirm-remote-control-requested/2650
- Windows RDP включение по SSH: https://gist.github.com/asheroto/530748b3bf0528cc4805d652b612f81f · https://www.helpwire.app/blog/powershell-enable-remote-desktop/
- Sunshine (NVENC Win+Linux, KWin-screencast, Wayland-захват): https://github.com/lizardbyte/sunshine · https://www.gamingonlinux.com/2026/05/sunshine-game-streaming-tool-adds-vulkan-encoding-plus-xdg-pipewire-and-kwin-direct-screencast-capture/
- Sunshine ввод через uinput (реальная Wayland-сессия): https://www.reddit.com/r/MoonlightStreaming/comments/1tpid3i/fixing_mouse_and_keyboard_input_not_passing/
- moonlight-web (unofficial WebRTC-мост Sunshine→браузер): https://github.com/MrCreativ3001/moonlight-web-stream
- IronRDP + web (Cloudflare browser-based RDP, RDCleanPath): https://github.com/Devolutions/IronRDP · https://blog.cloudflare.com/browser-based-rdp/
- MeshCentral (авто-деплой агента; Wayland-KVM слаб): https://www.openmsp.ai/blog/meshcentral-guide · https://github.com/Ylianst/MeshCentral/discussions/6316
- Selkies/KasmVNC = headless/контейнер (не физ. сессия): https://www.linuxserver.io/blog/webtop-4-1-x11-is-dead-and-what-is-selkies-anyway · https://docs.linuxserver.io/images/docker-baseimage-selkies/
- RustDesk web-клиент self-host ПЛАТНЫЙ: https://www.reddit.com/r/selfhosted/comments/1klkh4k/open_letter_to_rustdesk_about_the_web_client/ · https://www.reddit.com/r/selfhosted/comments/1smy771/stay_away_from_rustdesk_if_you_want_to_selfhost_it/
- RustDesk Wayland (portal+uinput, native, AGPL): https://rustdesk.com/blog/rustdesk-for-linux
