# Запертая машина и удалённый экран: что реально работает на Linux, Windows и macOS

Разбор для Argus: **как надёжно получить рабочий экран удалённо, когда машина заперта или в неё
никто не вошёл.** Каждое утверждение — со ссылкой на первоисточник (man-страницы systemd с самой
машины, исходники systemd/GNOME/KDE, Microsoft Learn, документация Apple). Догадки помечены
отдельно и собраны в конце в разделе «Чего я не проверил».

Дата: 2026-07-30. Стенд: ПК `castiel-pc` — Arch Linux, KDE Plasma 6, Wayland; ноут Vivobook —
Arch, `systemd 260.2-2-arch`, Plasma 6.6.5. Живых машин с Windows-логон-экраном и macOS в разборе
не было — соответствующие разделы построены на документации вендоров и явно это помечают.

---

## 0. С чего всё началось (живые факты, проверены на стенде)

- Агент ставится пользовательской службой systemd (`systemctl --user`), у пользователя включён
  `linger=yes` → служба поднимается при загрузке, **не дожидаясь входа в графику**.
- Графическая сессия стартует сама (автовход, дисплей-менеджер с `Relogin=true`).
- Экран владельца **был заблокирован** (`loginctl show-session N -p LockedHint` → `yes`), и именно
  поэтому удалённый просмотр не давал ничего полезного.
- `loginctl unlock-session N` снял блокировку удалённо, **пароль не потребовался**.

Ниже — почему это работает именно так, чем это подтверждается и что делать в остальных случаях.

---

## 1. LINUX: как найти нужный сеанс и снять замок

### 1.1 Какие поля читать и что они значат

`loginctl show-session <ID>` отдаёт плоский `key=value`. Значимые поля (проверено живым выводом на
ноуте, systemd 260):

```
Id=3            Seat=seat0      TTY=tty2      VTNr=2
Service=plasmalogin            Desktop=KDE
Remote=no       Type=wayland    Class=user
Active=yes      State=active    CanLock=yes    LockedHint=no
```

Что означает каждое поле — по документации, а не по интуиции:

| Поле | Допустимые значения | Смысл |
|---|---|---|
| `Type` | `x11`, `wayland`, `tty`, `mir`, `unspecified` | тип сеанса; графика — только первые три + `mir` |
| `Class` | `user`, `user-early`, `user-light`, `user-early-light`, `user-incomplete`, `greeter`, `lock-screen`, `background`, `background-light`, `manager`, `manager-early` | роль сеанса |
| `Active` | `yes`/`no` | сеанс «на переднем плане своего seat и доступен для ввода» |
| `State` | `online`, `active`, `closing` | `online` — вошёл, но не на переднем плане; `closing` — вышел, но процессы ещё живы |
| `Remote` | `yes`/`no` | известен ли удалённый хост (SSH-сеансы — `yes`) |
| `CanLock` | `yes`/`no` | поддерживает ли **класс** сеанса понятие блокировки экрана |
| `LockedHint` | `yes`/`no` | «подсказка о блокировке», её ставит рабочая среда |

Списки значений `Type`/`Class` и определения `Active`/`State`/`Remote` — из
[`sd_session_is_active(3)`](https://www.freedesktop.org/software/systemd/man/latest/sd_session_is_active.html)
(проверено по man-странице, установленной systemd 260 на самой машине):
«*The returned string is one of "x11", "wayland", "tty", "mir" or "unspecified"*»;
«*one of "user", "user-early", "user-light", "user-early-light", "user-incomplete", "greeter",
"lock-screen", "background", "background-light", "manager" or "manager-early"*»;
`sd_session_is_active` — «*currently active (i.e. currently in the foreground and available for user
input)*»; `sd_session_is_remote` — «*a remote session (i.e. its remote host is known)*»;
`sd_session_get_state` — «*"online" (session logged in, but session not active, i.e. not in the
foreground), "active" (…in the foreground), "closing" (session nominally logged out, but some
processes belonging to it are still around)*».

`LockedHint` и `CanLock` описаны в
[`org.freedesktop.login1(5)`](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html):
«*LockedHint shows the locked hint state of this session, as set by the SetLockedHint() method*»,
«*CanLock indicates whether the session supports the screen lock concept*».

**Признак «это живой локальный графический сеанс владельца»** — все условия сразу:

```
Class  = user            (или user-early / *-light; НЕ manager, НЕ greeter, НЕ background)
Type   ∈ {wayland, x11, mir}
Remote = no
Seat   непустой          (у сеансов без места нет физического экрана)
State  = active          (если online — сеанс есть, но он не на переднем плане, см. §1.7)
UID    = UID владельца
```

Две ловушки, из-за которых «очевидные» проверки врут:

1. **`Class=manager` — это не сеанс пользователя.** На живом ноуте `loginctl list-sessions`
   показывает ДВА сеанса одного UID: `1 … manager` (это `systemd --user`, следствие `linger=yes`)
   и `3 … user`. У первого `Type=unspecified`, `CanLock=no`. Фильтр «первый сеанс моего UID»
   выберет именно его — и всё сломается. Класс `manager` появился в systemd вместе с остальными
   классами из списка выше.
2. **`CanLock=yes` не значит, что в системе есть блокировщик.** Это чисто классовая проверка,
   вот макрос из исходника
   [`logind-session.h`](https://github.com/systemd/systemd/blob/main/src/login/logind-session.h):
   `#define SESSION_CLASS_CAN_LOCK(class) (IN_SET((class), SESSION_USER, SESSION_USER_EARLY,
   SESSION_USER_EARLY_LIGHT, SESSION_USER_LIGHT))` под комментарием «*Which session classes have a
   lock screen concept?*». Про наличие и готовность блокировщика он не знает ничего.

### 1.2 Как найти сеанс, не зная его номера

Номер после перезагрузки меняется, поэтому его надо **вычислять**. Два способа, оба работают из
голого SSH-окружения (проверено запуском под `env -i`, то есть без переменных сеанса):

**Способ А — спросить logind, какой сеанс у пользователя главный:**

```bash
loginctl show-user danya -P Display      # → 3
```

Свойство `Display` объекта пользователя описано в
[`org.freedesktop.login1(5)`](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html):
«*Display encodes which graphical session should be used as the primary UI display for the user*».

Как logind его выбирает — видно в
[`logind-user.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-user.c):
фильтр `elect_display_filter()` = `SESSION_CLASS_CAN_DISPLAY(s->class) && s->started && !s->stopping`,
а сравнение `elect_display_compare()` ранжирует по типу — `[SESSION_X11] = -3, [SESSION_WAYLAND] = -3,
[SESSION_MIR] = -3, [SESSION_TTY] = -2, [SESSION_WEB] = -1, [SESSION_UNSPECIFIED] = 0` (меньше = лучше)
и предпочитает `SESSION_USER` и не-`stopping`. Комментарий в `user_elect_display()` честный:
«*We try to keep the assignment stable, but we "upgrade" to better choices*».

**Важное следствие: `Display` НЕ смотрит на `Active`.** В `elect_display_compare` нет ни слова про
активность, а два равнозначных wayland-сеанса класса `user` дают `return 0` — «равнозначны», и
выбранным остаётся тот, что был избран раньше. То есть `Display` может указывать на залипший сеанс.
Поэтому `Display` — подсказка, а не истина: полученный ID **всё равно надо проверить** по §1.1.

**Способ Б (надёжнее) — перебрать всё и отфильтровать самому.** Одна SSH-команда, один вызов:

```bash
loginctl show-session $(loginctl list-sessions --no-legend | awk '{print $1}') \
  -p Id -p Name -p User -p Type -p Class -p Active -p State -p Remote \
  -p LockedHint -p CanLock -p Seat -p Desktop -p Service
```

`show-session` принимает несколько ID и печатает блоки, разделённые пустой строкой, каждый
начинается с `Id=` (проверено живым выводом). Дальше фильтр из §1.1 применяется в Argus.

Для машинного разбора списка есть и JSON, но **только у `list-sessions`**:
`loginctl list-sessions --json=short` →
`[{"session":"1","uid":1000,…,"class":"manager",…},{"session":"3",…,"class":"user",…}]`.
Полей `type`/`active`/`remote` там нет, поэтому без `show-session` не обойтись. И не путать с
`-o/--output` — это режим вывода журнала, `--output=json` для `list-sessions` молча игнорируется
(проверено: печатает обычную таблицу).

### 1.3 Что вернёт loginctl, если сеансов несколько

`list-sessions` вернёт **все** — включая залипшие. Живой пример с ноута:

```
SESSION  UID USER  SEAT  LEADER CLASS   TTY  IDLE SINCE
      1 1000 danya -     789    manager -    no   -
      3 1000 danya seat0 3863   user    tty2 no   -
```

Что бывает в списке кроме нужного сеанса:

- **`Class=manager`** — `systemd --user`. Всегда есть при `linger=yes`, `Seat` пустой.
- **`Remote=yes`, `Type=tty`** — сам SSH-сеанс Argus. Их будет столько, сколько параллельных
  подключений; они тоже `Class=user`, и без фильтра `Remote=no` попадут в выборку.
- **`State=closing`** — «*nominally logged out, but some processes belonging to it are still
  around*» ([`sd_session_is_active(3)`](https://www.freedesktop.org/software/systemd/man/latest/sd_session_is_active.html)).
  Это и есть «залипший старый»: снимать замок с него бессмысленно.
- **`Class=greeter`** — сеанс экрана приветствия, живёт под своим системным пользователем
  (`sddm` / `plasmalogin`, см. §2.1), UID не совпадает с владельцем.
- **`Active=no`, `State=online`** — реальный графический сеанс, но не на переднем плане: владелец
  переключился на другой VT или дисплей-менеджер показывает «сменить пользователя». Замок снимать
  можно, но увидеть картинку получится только после `activate` (§1.7).

Правило для Argus: **если после фильтрации подходящих сеансов ноль — это не «выключено», это
«графики нет» (см. §2). Если больше одного — брать `State=active`, а при равенстве не угадывать,
а показать выбор владельцу.** Это ровно та же дисциплина честности статусов, что уже принята в
Argus для опроса парка.

### 1.4 Права: почему `unlock-session` по SSH сработал без пароля

Разбор по исходникам systemd — и он полностью объясняет живое наблюдение.

**Полномочие ровно одно.** В `/usr/share/polkit-1/actions/org.freedesktop.login1.policy` (файл с
машины) лок-действие единственное:

```xml
<action id="org.freedesktop.login1.lock-sessions">
  <description>Lock or unlock active sessions</description>
  <defaults>
    <allow_any>auth_admin_keep</allow_any>
    <allow_inactive>auth_admin_keep</allow_inactive>
    <allow_active>auth_admin_keep</allow_active>
  </defaults>
</action>
```

То есть «по бумаге» на разблокировку нужна админская аутентификация в любом случае. Но реальный
код проверяет иначе.

**Пер-сеансовый `Unlock()` имеет обход для своего владельца.** В
[`logind-session-dbus.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-session-dbus.c)
обработчик `bus_session_method_lock()` вызывает:

```c
r = bus_verify_polkit_async_full(
        message,
        "org.freedesktop.login1.lock-sessions",
        /* details= */ NULL,
        s->user->user_record->uid,     // ← good_user
        /* flags= */ 0, …);
```

Четвёртый аргумент — `good_user`. В
[`bus-polkit.c`](https://github.com/systemd/systemd/blob/main/src/shared/bus-polkit.c)
функция начинается с проверки:

```c
r = bus_message_check_good_user(call, good_user, &admin);
if (r != 0) { … return r; }      // r>0 → доступ разрешён, polkit НЕ спрашивается
```

а `bus_message_check_good_user()` заканчивается `return sender_uid == good_user;`. Итог: **если
вызывающий — тот же пользователь, что владеет сеансом, polkit не спрашивается вообще.** Никаких
дополнительных прав, групп и polkit-правил не нужно. Именно это и наблюдалось по SSH.

**Root тоже проходит, но по другой причине.** Дальше в той же функции:

```c
r = sd_bus_query_sender_privilege(call, /* capability= */ -1);
if (r > 0) { … return 1; }
```

`sd_bus_query_sender_privilege(3)` (man-страница с машины): «*If capability is a negative integer,
this function returns whether the sender of the message runs as the same user as the receiver of the
message, or if the sender of the message runs as root and the receiver of the message does not run
as root*». logind сам работает под root, значит для root-вызывающего срабатывает первая половина
(«тот же пользователь») → polkit опять не спрашивается.

**А вот `unlock-sessions` (все сеансы) по SSH упадёт.** Менеджерский метод в
[`logind-dbus.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-dbus.c) вызывает
короткую обёртку `bus_verify_polkit_async(...)`, а она в
[`bus-polkit.h`](https://github.com/systemd/systemd/blob/main/src/shared/bus-polkit.h) определена так:

```c
return bus_verify_polkit_async_full(call, action, details, UID_INVALID, 0, registry, NULL, reterr_error);
```

`good_user = UID_INVALID` → обхода нет → действие с `auth_admin_keep`. SSH-сеанс для polkit не
«локальная консоль», поэтому применяется `allow_any`
([`polkit(8)`](https://www.freedesktop.org/software/polkit/docs/latest/polkit.8.html), man-страница
с машины: «*allow_any — Implicit authorizations that apply to any client*»; «*allow_active —
…clients in active sessions on local consoles*»). Агента аутентификации в SSH нет → ошибка
«Interactive authentication required».

**Вывод для Argus: всегда `unlock-session <конкретный ID>` от имени владельца сеанса. Никогда
`unlock-sessions`.**

Отдельно: на сеансе, который не умеет блокироваться, команда честно падает — проверено живьём на
`Class=manager`:

```
$ loginctl lock-session 1
Failed to issue method call: Session does not support lock screen.   (exit=1)
```

### 1.5 Все ли рабочие среды слушают `Unlock` от logind

**Нет, и это главный подвох.** logind сам ничего не разблокирует — он только рассылает сигнал.
[`org.freedesktop.login1(5)`](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html):
«*UnlockSession() asks the session with the specified ID to remove an active screen lock, if there is
any. This is implemented by sending out the Lock() and Unlock() signals from the respective session
object **which session managers are supposed to listen on***»; и про сам сигнал: «*Lock()/Unlock() is
sent when the session is asked to be screen-locked/unlocked. **A session manager of the session should
listen to this signal and act accordingly***».

Значит нулевой код возврата `loginctl unlock-session` означает ровно одно: **сигнал отправлен.**

Кто его действительно слушает:

- **KDE Plasma — да.** В [`ksldapp.cpp`](https://invent.kde.org/plasma/kscreenlocker/-/blob/master/ksldapp.cpp)
  (kscreenlocker):
  ```cpp
  connect(m_logind, &LogindIntegration::requestUnlock, this, [this]() {
      if (lockState() == Locked || lockState() == AcquiringLock) {
          if (m_lockProcess->state() != QProcess::NotRunning) { s_logindExit = true; m_lockProcess->terminate(); }
          else { doUnlock(); }
      }
  });
  ```
  и обратная связь в logind: `connect(this, &KSldApp::unlocked, … m_logind->setLocked(false); …)`.
- **GNOME — да.** В [`screenShield.js`](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/screenShield.js):
  `this._loginSession.connectSignal('Unlock', () => this.deactivate(false));`. Разблокировка полная,
  а не «занавес приподняли»: цепочка доходит до `_completeDeactivate()`, где `this._dialog.destroy()`,
  `this.actor.hide()`, `this._setActive(false)`, `this._setLocked(false)`; а `_setLocked()` вызывает
  `this._loginSession.SetLockedHintAsync(locked)`.
- **Sway/wlroots — только если настроено вручную.** Сам `swaylock` про logind не знает. Мост — это
  `swayidle`, у которого есть событие `unlock`: «*executes command when logind signals that the
  session should be unlocked*» ([`swayidle(1)`](https://github.com/swaywm/swayidle/blob/master/swayidle.1.scd)).
  Команду надо прописать самому, и разблокировать `swaylock` можно только сигналом:
  [`swaylock(1)`](https://github.com/swaywm/swaylock/blob/master/swaylock.1.scd) документирует
  `SIGUSR1` — «*Unlock the screen and exit*». В конфигурации по умолчанию `loginctl unlock-session`
  под Sway **не делает ничего**.
- **Остальные** (XFCE, Cinnamon, i3lock и прочие) — по этому же признаку: есть привязка к logind →
  работает, нет → нет. Проверять надо на конкретной машине, а не предполагать.

### 1.6 Как убедиться программно, что разблокировка ДЕЙСТВИТЕЛЬНО произошла

Три независимых способа, от дешёвого к честному.

**(а) `LockedHint` — но понимать, что это.** Это подсказка, которую выставляет сама рабочая среда:
«*SetLockedHint() may be used to set the "locked hint"… This is intended to be used by the desktop
environment to tell systemd-logind when the session is locked and unlocked*»
([`org.freedesktop.login1(5)`](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html)).
polkit тут не участвует, проверка простая — из
[`logind-session-dbus.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-session-dbus.c):
`if (uid != 0 && uid != s->user->user_record->uid) return sd_bus_error_set(error,
SD_BUS_ERROR_ACCESS_DENIED, "Only owner of session may set locked hint");`.

И KDE, и GNOME честно его обновляют (см. код в §1.5), поэтому **переход `LockedHint` из `yes` в `no`
— достоверный сигнал, что среда действительно отработала unlock:**

```bash
loginctl show-session 3 -P LockedHint      # ждём "no" в течение 2–3 с после unlock
```

Если через несколько секунд всё ещё `yes` — среда сигнал проигнорировала (Sway без настройки,
экзотический блокировщик). Argus должен сказать это прямо, а не «разблокировано».

**(б) Спросить сам блокировщик по D-Bus.** Независимый от logind канал. На живом Plasma 6.6 имя
`org.freedesktop.ScreenSaver` и `org.kde.screensaver` **принадлежат `kwin_wayland`**, и опрос
работает даже из голого окружения (проверено под `env -i`, только `XDG_RUNTIME_DIR`):

```bash
env XDG_RUNTIME_DIR=/run/user/1000 \
  busctl --user call org.freedesktop.ScreenSaver /org/freedesktop/ScreenSaver \
  org.freedesktop.ScreenSaver GetActive
# → b false     (false = не заблокировано)
```

Ключевой момент: **шина пользователя одна на пользователя, а не на сеанс** — поэтому из
SSH-подключения достаточно указать `XDG_RUNTIME_DIR`, и `busctl --user` попадает на ту же шину, что
и графический сеанс. Проверено живьём.

**(в) Единственное настоящее доказательство — кадр.** Всё выше — это чужие слова о состоянии.
Твёрдый критерий у Argus уже есть и он правильный: **вариант захвата считается рабочим, только если
пришли кадры.** Здесь тот же принцип: разблокировка удалась, если после неё агент отдаёт **новые,
меняющиеся** кадры. У KDE это особенно важно, потому что по собственной документации KWin
«*As long as the screen is locked and no user interaction the compositor just stops repainting (no
window content is shown)*» ([KWin/Screenlocker](https://community.kde.org/KWin/Screenlocker)) — то
есть при заблокированном экране поток может быть жив, а картинка в нём стоять. Один кадр ничего не
доказывает; доказывает изменение кадров.

### 1.7 Смежные состояния, которые выглядят как «замок»

- **`Active=no` / `State=online`** — сеанс не на переднем плане. Лечится
  `loginctl activate <ID>`: «*This brings a session into the foreground if another session is
  currently in the foreground on the respective seat*»
  ([`loginctl(1)`](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)).
  **Но права тут другие и хуже.** `bus_session_method_activate()` идёт через `check_polkit_chvt()`
  ([`logind-polkit.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-polkit.c)):
  ```c
  return bus_verify_polkit_async(message, "org.freedesktop.login1.chvt", NULL, &manager->polkit_registry, error);
  ```
  — короткая обёртка, то есть `good_user = UID_INVALID`, обхода для владельца **нет**. А у действия
  `chvt` в policy-файле с машины: `allow_active=yes`, `allow_inactive=yes`, **`allow_any=auth_admin_keep`**.
  SSH — это `allow_any`. Значит `loginctl activate` по SSH от обычного пользователя, скорее всего,
  потребует аутентификации и упадёт, а от **root** — пройдёт (через `sd_bus_query_sender_privilege`,
  §1.4). На живом SSH это не проверялось — см. «Чего я не проверил».
- **Погасший монитор (DPMS).** Замка нет, `LockedHint=no`, а картинки нет или она стоит. Два
  доступных способа разбудить: `kscreen-doctor --dpms on` (есть на машине; `--help`: «*Set dpms mode:
  (possible values: on, off)*», «*Display power management (wayland only)*») либо синтетический ввод
  через `/dev/uinput`, который у агента уже реализован — событие уровня ядра выглядит для
  композитора как настоящее и гасит DPMS.
- **Ввод через uinput на заблокированном экране попадает в блокировщик.** Технически это значит, что
  агент мог бы «напечатать» пароль ОС. Делать этого не надо: весь смысл своего агента был в том,
  что пароль учётной записи из цепочки исчезает. `unlock-session` даёт то же самое без пароля.

---

## 2. LINUX: случай «никто не вошёл»

### 2.1 Что там вообще есть

Экран приветствия — это **отдельный сеанс отдельного пользователя со своим композитором**.
Класс сеанса — `greeter`, он есть в списке классов
[`sd_session_is_active(3)`](https://www.freedesktop.org/software/systemd/man/latest/sd_session_is_active.html).
Пользователь — выделенная системная учётка; на машине это видно в sysusers-файлах пакетов:
`u plasmalogin - "PLASMALOGIN Greeter Account" /var/lib/plasmalogin` и
`u sddm - "SDDM Greeter Account" /var/lib/sddm`. У greeter'а собственный PAM-стек
(`/usr/lib/pam.d/plasmalogin-greeter`).

Что из этого следует для агента:

- Агент владельца в этот момент **должен быть жив** и отвечать на `/health`: юнит стоит с
  `WantedBy=default.target`, а `After=graphical-session.target` только упорядочивает и ничего не
  требует, поэтому при `linger=yes` пользовательский менеджер доходит до `default.target` уже при
  загрузке. Захватывать ему при этом нечего: `WAYLAND_DISPLAY`-сокета владельца нет, `DISPLAY=:0`
  принадлежит не ему. **Это отличимое состояние: «агент отвечает, дисплея нет» ≠ «машина
  выключена»**, и Argus обязан их различать. (На стенде в таком состоянии не проверялось — см. «Чего
  я не проверил».)
- Токен восстановления портала (агент хранит его в `~/.argus/screencast-token`, `persist_mode=2`)
  тут не помогает: восстанавливать нечего, портал живёт внутри сеанса, которого нет.

### 2.2 Можно ли показать сам greeter удалённо — прямой ответ

**Нет. Поддерживаемого способа увидеть физический экран приветствия удалённо на Wayland не
существует.** Причина в модели Wayland: картинку отдаёт композитор, и только через
`xdg-desktop-portal`, который требует согласия в диалоге — а диалог показывать некому и подтверждать
нечем. Портальный `restore_token` тоже не выход: он «*single use token*» и выдаётся сеансу
приложения, а не системе
([ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)).

Три оговорки, которые честнее назвать вслух:

1. **X11-greeter — исключение.** Если дисплей-менеджер поднимает greeter на X11, root может
   захватить его `x11grab`, указав `DISPLAY=:0` и `XAUTHORITY` из рантайм-каталога менеджера. Путь к
   этому файлу нигде не документирован и меняется от версии к версии → в «не проверил».
2. **`kmsgrab` из системной службы — единственный реальный шанс увидеть ФИЗИЧЕСКИЙ экран.** Про
   права документация ffmpeg говорит буквально: «*Requires either DRM master or CAP_SYS_ADMIN to
   run*» ([ffmpeg-devices, kmsgrab](https://ffmpeg.org/ffmpeg-devices.html#kmsgrab)). То есть
   **DRM-мастером быть не обязательно — достаточно `CAP_SYS_ADMIN`**. Это прямо противоречит текущей
   формулировке в `agent/README.md` («kmsgrab требует прав DRM-мастера») и означает: агент,
   запущенный **системной** службой под root, в принципе может снимать буфер развёртки CRTC
   независимо от того, кто композитит — включая greeter и экран блокировки. Оговорки: та же
   документация предупреждает, что прямой доступ к буферу «*will only work if the framebuffer is
   both linear and mappable*» (иначе нужен `hwmap`/VAAPI, что у Argus в аргументах уже есть), а на
   проприетарном драйвере NVIDIA импорт DMA-BUF может не пройти. **Это самый ценный непроверенный
   путь во всём разборе** — его стоит проверить на стенде первым.
3. **`Xvfb`/headless-композитор** — это уже не физический экран, а второй рабочий стол. Годится для
   «дать себе рабочее место», не годится для «посмотреть, что на мониторе».

### 2.3 Автовход: что именно менять и чем это опасно

Автовход не «показывает greeter», он **делает так, чтобы greeter'а не было** — сеанс поднимается
сам, и дальше работает обычный путь §1.

**SDDM** — [`sddm.conf(5)`](https://man.archlinux.org/man/sddm.conf.5) (man-страница с машины,
sddm 0.21.0), секция `[Autologin]`:

- `User=` — «*Name of the user to automatically log in when the system starts first time*»
- `Session=` — «*Name of the session to automatically log in when the system starts first time*»
- `Relogin=` — «*If true and User and Session are set automatic login will kick in again on session
  exit, otherwise it will work only the first time. Default value is false.*»

**GDM** — `/etc/gdm/custom.conf`, секция `[daemon]`: `AutomaticLoginEnable=True` и
`AutomaticLogin=<user>`
([GNOME System Administration Guide](https://help.gnome.org/admin/system-admin-guide/stable/login-automatic.html.en)).

**plasma-login-manager** (Plasma 6.6, стоит на ноуте вместо SDDM: служба `plasmalogin.service`,
PAM-стек `plasmalogin-autologin`) автовход поддерживает: конфиг — **`/etc/plasmalogin.conf`** (путь
взят из строк KAuth-помощника `/usr/lib/kf6/kauth/kcmplasmalogin_authhelper`, который его и пишет),
на машине файла ещё нет — значит действуют значения по умолчанию. Man-страницы у пакета нет, точные
имена ключей по строкам бинаря не восстанавливаются (видны `autologin`, `user`, `session`) → правит
это графический модуль «Экран входа» в системных настройках, а не рука. Точные ключи — в «не проверил».

Чем это опасно — по пунктам, без благодушия:

- **Кто дошёл до клавиатуры, тот вошёл.** Пароль учётной записи перестаёт что-либо защищать после
  загрузки. Шифрование диска (LUKS) продолжает защищать выключенную машину — на включённой с
  автовходом оно не помогает.
- **Кошелёк открывается вместе с сеансом.** В PAM-стеке автовхода на машине уже стоят
  `pam_kwallet5.so … auto_start` и `pam_gnome_keyring.so auto_start` — то есть KWallet/keyring
  разблокируются автоматически. Все сохранённые в них пароли (включая пароли браузера) становятся
  доступны любому, кто получил сеанс. Своего мастер-пароля Argus это не касается, но общая
  чувствительность машины растёт заметно.
- **`Relogin=true` убирает последний барьер.** Без него «выйти из сеанса» оставляет greeter; с ним
  сеанс поднимается снова сам.
- Взамен получаем ровно одно: машина после перезагрузки сама приходит в состояние, где §1 работает.
  Для личного ПК за NAT, к которому ходят только по Tailscale, это осмысленный обмен — но обмен, а
  не бесплатное улучшение, и решение владельца, а не Argus.

### 2.4 «Отдельная служба уровня системы» — что она может и чего нет

- **Захватить чужой Wayland-композитор — не может.** Никакого системного API для этого нет; портал
  работает внутри сеанса.
- **`kmsgrab` под `CAP_SYS_ADMIN` — может (в теории, см. §2.2 п.2).** Это и есть тот случай, где
  системная служба даёт то, чего не даёт пользовательская.
- **Поднять свой headless-сеанс — может, но это другой рабочий стол.** Готовое решение на GNOME —
  «remote login» у `gnome-remote-desktop`: по его
  [README](https://github.com/GNOME/gnome-remote-desktop/blob/main/README.md) поддерживаются три
  режима, и третий — «*headless remote login remote desktop server*», который «*supports integrating
  with the GNOME Display Manager (GDM) to achieve remote login functionality*» и доступен «*only via
  the RDP protocol*». Схема входа: «*the remote user first authenticating via a system wide password,
  which gives access to the graphical login screen, where they can login using their user specific
  credentials*». Настройка: `grdctl --system rdp set-tls-key` / `set-tls-cert` / `set-credentials` /
  `enable`, плюс включённые `gdm.service` и системный `gnome-remote-desktop.service`; «*Connecting
  via RDP requires setting up a TLS key and a TLS certificate*».

  **Но читать это надо буквально: режим headless.** Это НОВЫЙ виртуальный сеанс, а не вид на
  физический монитор. Ровно как RDP на Windows. Для «посмотреть, что сейчас на экране ПК» не
  подходит. И у владельца KDE, а не GNOME — аналога с логон-экраном в Plasma нет
  (KRdp обслуживает текущий сеанс пользователя).

**Честный итог по §2: способа удалённо увидеть физический экран Linux-машины, в которую никто не
вошёл, штатными средствами НЕТ.** Есть три обхода: автовход (§2.3, меняет модель безопасности),
`kmsgrab` из root-службы (§2.2, самый перспективный, не проверен) и headless-сеанс (§2.4, другой
рабочий стол). Argus в этом состоянии должен говорить «в машину никто не вошёл» — и предлагать
включить автовход, а не изображать неудачу связи.

---

## 3. WINDOWS

### 3.1 Изоляция сессий и защищённый рабочий стол — подтверждено

**Обычный процесс не может снять экран блокировки и экран входа. Служба — тоже не может.**

- Службы: «*Services cannot directly interact with a user as of Windows Vista*»; «*By default,
  services use a noninteractive window station and cannot interact with the user*»; «*All services
  run in Terminal Services session 0*»
  ([Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)).
  Это ровно та причина, по которой агент Argus на Windows ставится задачей планировщика с триггером
  на вход, а не службой — решение в проекте уже правильное.
- Оконные станции: «*The interactive window station is the only window station that can display a
  user interface or receive user input… It is always named "WinSta0". All other window stations are
  noninteractive*» ([Window Stations](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations)).
- Рабочие столы: «*By default, there are three desktops in the interactive window station: Default,
  ScreenSaver, and Winlogon*»; «*The Winlogon desktop is active while a user logs on… the system
  switches to the Winlogon desktop when the user presses the CTRL+ALT+DEL key sequence, or when the
  User Account Control (UAC) dialog box is open*»; и главное —
  «*The Winlogon desktop's security descriptor allows access to a very restricted set of accounts,
  including the LocalSystem account. **Applications generally do not carry any of these accounts'
  SIDs in their tokens and therefore cannot access the Winlogon desktop** or switch to a different
  desktop while the Winlogon desktop is active*»
  ([Desktops](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops)).

То есть запрет не «эвристический», а прописан в DACL рабочего стола: нужны SID уровня LocalSystem.

### 3.2 Что технически требуется, чтобы всё-таки добраться до экрана входа

Цепочка, которой пользуются продукты удалённого доступа, и что документация говорит про каждое звено:

| Звено | Требование по документации |
|---|---|
| `WTSGetActiveConsoleSessionId` | сессия, привязанная к физической консоли ([ссылка](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-wtsgetactiveconsolesessionid)) |
| `WTSQueryUserToken` | «*must be running within the context of the LocalSystem account and have the `SE_TCB_NAME` privilege*» ([ссылка](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken)) |
| `DuplicateTokenEx` | `TokenPrimary` → «*a primary token that you can use in the CreateProcessAsUser function*» ([ссылка](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-duplicatetokenex)) |
| `SetTokenInformation(TokenSessionId)` | смена сессии: «*The process is run in the session specified in the token… To change the session, use the SetTokenInformation function*» (в доке `CreateProcessAsUser`) |
| `CreateProcessAsUser` | «*must have the `SE_INCREASE_QUOTA_NAME` privilege and may require the `SE_ASSIGNPRIMARYTOKEN_NAME` privilege*»; ошибка `ERROR_PRIVILEGE_NOT_HELD` (1314); интерактивность — только «*specify the name of the default interactive window station and desktop, `"winsta0\default"`*» ([ссылка](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)) |

Два вывода, которые важнее самой цепочки:

1. **`lpDesktop = "winsta0\Winlogon"` — не документированный путь.** Microsoft описывает как
   интерактивную цель только `winsta0\default`, а Winlogon-рабочий стол закрыт DACL'ом под
   LocalSystem (§3.1). Значит «запустить захватчик на логон-экране» — это не «настроить права», а
   «работать как SYSTEM на защищённом рабочем столе», чего Microsoft не документирует и API для
   захвата под это не даёт.
2. **Когда никто не вошёл, токена пользователя просто нет.** Страница `WTSQueryUserToken` не
   описывает этот случай прямо (говорит только «*If the function fails, the return value is zero*»),
   но логика однозначна: консольную сессию с логон-экраном держат SYSTEM/Winlogon, пользователя в
   ней нет. Конкретный код ошибки — только из форумов, в «не проверил».

### 3.3 API захвата на защищённом рабочем столе

- **DXGI Desktop Duplication** (это `ddagrab`): `AcquireNextFrame` возвращает `DXGI_ERROR_ACCESS_LOST`,
  и документация прямо перечисляет причины: «*The desktop duplication interface typically becomes
  invalid when a different type of image is displayed on the desktop. Examples of this situation are:
  — **Desktop switch** — Mode change — Switch from DWM on, DWM off, or other full-screen
  application*»; «*the application must release the IDXGIOutputDuplication interface and create a new
  IDXGIOutputDuplication*»
  ([AcquireNextFrame](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe)).
  Блокировка, UAC и логон-экран — это и есть «desktop switch». Пересоздание помогает вернуться к
  обычному рабочему столу, но не даёт увидеть защищённый.
- **Windows.Graphics.Capture** — поведение на защищённом рабочем столе **в документации не описано**.
  Официально задокументированы только выбор источника через системный UI, рамка захвата и
  `GraphicsCaptureSession.IsSupported()`
  ([Screen capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)).
  Утверждать конкретный код ошибки нельзя.
- **GDI/`BitBlt`** (это `gdigrab`) — отдельного утверждения «не может снять экран блокировки» в
  документации нет. Вывод структурный: DC читает **тот рабочий стол, к которому подключён процесс**,
  а процесс на `winsta0\Default` на Winlogon-стол не попадает по DACL (§3.1). Практический результат
  — чёрный или застывший кадр.

### 3.4 Разблокировать Windows удалённо без пароля

**Такого API нет.** Документация `LockWorkStation` говорит это в лоб: «*To unlock the workstation,
**the user must log in**. **There is no function you can call to determine whether the workstation is
locked**.*»
([LockWorkStation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation)).
То есть нет не только разблокировки — нет даже прямого запроса «заперто ли» (как это обходить —
§3.6). Провайдеры учётных данных (credential providers) собирают учётные данные для Winlogon, а не
обходят проверку.

Что есть вместо этого — два способа привести машину в состояние «вошёл, но заперт»:

- **AutoAdminLogon** — `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`:
  `AutoAdminLogon=1`, `DefaultUserName`, `DefaultPassword`. Предупреждение самой Microsoft:
  «*anyone who can physically obtain access to the computer can gain access to all the computer's
  contents… when autologon is turned on, **the password is stored in the registry in plain text**.
  The specific registry key that stores this value **can be remotely read by the Authenticated Users
  group***»
  ([Turn on automatic logon](https://learn.microsoft.com/en-us/troubleshoot/windows-server/user-profiles-and-logon/turn-on-automatic-logon)).
  Sysinternals Autologon хранит пароль как LSA-секрет — это заметно лучше, но всё равно автовход.
- **ARSO + `shutdown /g`** — «*Fully shuts down and restarts the computer. On restart, if Automatic
  Restart Sign-On is enabled, **the device automatically signs in and locks** based on the last
  interactive user*» ([shutdown](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown)).
  Сам ARSO: «*the user will automatically be signed in via the Autologon mechanism and then
  additionally **locked** to protect the user's session*»; «*Can only be enabled if BitLocker is
  enabled*»; выключается политикой «*Sign-in last interactive user automatically after a
  system-initiated restart*» или `DisableAutomaticRestartSignOn`
  ([ARSO](https://learn.microsoft.com/en-us/windows-server/security/windows-authentication/winlogon-automatic-restart-sign-on-arso)).

  Ключевое: **`/g` даёт «вошёл и заперт», а не «вошёл и открыт».** Для захвата экрана это не решение.

### 3.5 RDP: как он ведёт себя в каждом состоянии

**(а) Никого нет в системе.** RDP **не показывает** физический экран входа. С NLA клиент
аутентифицируется до создания сеанса: «*Network Level Authentication is an authentication method…
requiring that the user be authenticated to the RD Session Host server before a session is
created*»; «*Network Level Authentication completes user authentication **before** you establish a
remote desktop connection and the logon screen appears*»
([Configure NLA](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2008-R2-and-2008/cc732713(v=ws.11))).
То есть RDP **создаёт свой сеанс** для указанного пользователя — с паролем, который агент как раз и
пытался убрать из цепочки.

**(б) Консоль заперта, подключаемся тем же пользователем.** На клиентских редакциях (один
интерактивный сеанс) подключение **переиспользует существующий сеанс** пользователя, а физическая
консоль его теряет. Одной чеканной фразы в документации на это нет; ближайшее прямое —
определение состояния `WTSDisconnected`: «*The WinStation is active but the client is disconnected.
This state occurs when a user is signed in but not actively connected to the device, such as when
the user has chosen to exit to the lock screen*»
([WTS_CONNECTSTATE_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ne-wtsapi32-wts_connectstate_class)).
Побочный эффект для Argus существенный: **RDP-вход «уводит» сеанс с монитора**, и если владелец
сидит за ПК, он это увидит.

**(в) Вернуть сеанс на физический монитор — `tscon`.** Документация
([tscon](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tscon)):
«*You must have Full Control access permission or Connect special access permission to connect to
another session*»; про пароль — «*This password is required when the connecting user does not own the
session*» и «*This command fails if you don't specify a password… and the target session belongs to a
user other than the current one*» → **для своего сеанса пароль не нужен**. Оговорка: конкретная форма
`tscon <id> /dest:console` в официальных примерах отсутствует (там числовые ID и имена вида
`TERM03`), а в Remarks есть строка «*You can't connect to the console session*» — она про консоль как
ИСТОЧНИК. Права и правило про пароль подтверждены, а сам приём «вернуть на консоль» — практика
сообщества → в «не проверил».

**(г) Редакции.** «*You can use Remote Desktop to connect to computers running Windows Professional,
Enterprise, Education editions, and Windows Server editions… **However, Windows Home editions can't
serve as Remote Desktop hosts**, though they can be used as clients*»
([Enable Remote Desktop](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access)).
Для Argus это значит: RDP как запасной путь есть не у всех Windows-машин, а свой агент — у всех.

### 3.6 Как читать состояние сессии удалённо

Прямого API «заперто ли» нет (§3.4), но состояние читается:

- CLI: `query session` / `qwinsta`
  ([query session](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/query-session)) —
  это то, что удобно вызывать по SSH так же, как `loginctl` на Linux.
- API: `WTSEnumerateSessions` → `State` типа `WTS_CONNECTSTATE_CLASS`: `WTSActive` — «*A user is
  logged on to the WinStation… actively connected to the device*», `WTSDisconnected` — см. выше,
  плюс `WTSConnected`, `WTSConnectQuery`, `WTSShadow`, `WTSIdle`, `WTSListen`, `WTSReset`, `WTSDown`,
  `WTSInit` ([ссылка](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ne-wtsapi32-wts_connectstate_class)).
- Флаг блокировки: `WTSQuerySessionInformation(WTSSessionInfoEx)` → `WTSINFOEX_LEVEL1.SessionFlags`:
  `WTS_SESSIONSTATE_LOCK = 0x0` («*The session is locked*»), `WTS_SESSIONSTATE_UNLOCK = 0x1`
  («*The session is unlocked*»), `WTS_SESSIONSTATE_UNKNOWN = 0xFFFFFFFF`
  ([WTSINFOEX_LEVEL1](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w)).
  **Задокументированный дефект:** «*Windows Server 2008 R2 and Windows 7: Due to a code defect, the
  usage of the WTS_SESSIONSTATE_LOCK and WTS_SESSIONSTATE_UNLOCK flags is reversed*» (на Windows 8+
  и Server 2012+ не действует).
- События: `WTSRegisterSessionNotification` → `WM_WTSSESSION_CHANGE` с `WTS_SESSION_LOCK` /
  `WTS_SESSION_UNLOCK` ([ссылка](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)) —
  правильный способ для агента, живущего в сеансе, сообщать Argus о блокировке сразу.

---

## 4. macOS

Здесь важно с самого начала разделить два состояния, которые на Linux и Windows выглядят похоже, а у
Apple устроены принципиально по-разному: **«вошёл, но заперт»** и **«никто не вошёл»**. Про второе
документация есть и путь есть; про первое документации нет вообще.

### 4.1 «Никто не вошёл» — это отдельный контекст, и он документирован

Экран входа живёт в **pre-login context** — своём bootstrap-пространстве имён. Типы сеансов задаются
ключом `LimitLoadToSessionType`: `Aqua` (GUI-агент пользователя), `StandardIO` (SSH), `Background`,
**`LoginWindow`** — «*Runs in the loginwindow context*»
([TN2083 Daemons and Agents](https://developer.apple.com/library/archive/technotes/tn2083/_index.html)).
Там же правило изоляции: «*services registered in a per-session namespace can only be seen by
processes using that per-session namespace*», и что после входа «*this pre-login bootstrap namespace
and security context become the bootstrap namespace and security context of the logged in user's
login session*».

**Отсюда прямо следует, что нынешняя форма агента Argus на macOS до экрана входа не достаёт**: он
поставлен как LaunchAgent пользователя (`~/Library/LaunchAgents/com.argus.agent.plist`,
`src/main/agent.ts`), то есть живёт в `Aqua`-сеансе, которого при отсутствии входа просто нет.

**Поддерживаемый способ всё-таки видеть экран входа существует** — и это официальная рекомендация
инженера Apple DTS (форум разработчиков Apple,
[thread 814152](https://developer.apple.com/forums/thread/814152)):

> «*Daemons should not be messing around with GUI stuff, and that includes ScreenCaptureKit. The
> standard architecture for a screen sharing product is to have both a daemon and an agent… If you
> want your product to support the pre-login context, set your agent's `LimitLoadToSession` property
> to an array value containing both `Aqua` and `LoginWindow`.*»
> «*IMPORTANT In macOS 14.4 we fixed a bug that prevents you from using ScreenCaptureKit in the
> pre-login context (r. 121253782).*»

Цена этого пути для Argus высокая и её надо назвать: захват должен идти через **ScreenCaptureKit**,
а не через ffmpeg/avfoundation, только на **macOS 14.4+**, из **подписанного** агента, который
загружается и в `Aqua`, и в `LoginWindow`. Из Go без cgo ScreenCaptureKit недостижим — понадобится
небольшой отдельный бинарь на Swift/Obj-C. Пример архитектуры Apple выкладывала сама
([PreLoginAgents](https://developer.apple.com/library/archive/samplecode/PreLoginAgents/Introduction/Intro.html)),
и pre-login-агенты работают под root
([thread 768146](https://developer.apple.com/forums/thread/768146)). Мелкая ловушка: DTS пишет
`LimitLoadToSession`, а документированное имя ключа — **`LimitLoadToSessionType`** (TN2083).

Отдельно: рекомендация Apple менялась. Годом раньше тот же DTS писал «*ScreenCaptureKit is not
available in the pre-login context*» ([thread 756908](https://developer.apple.com/forums/thread/756908)).
Актуальна версия из 814152 (macOS 14.4+).

### 4.2 «Вошёл, но экран заперт» — Apple это не документирует

**Что даёт и чего не даёт захват при заблокированном экране — в документации Apple не описано
никак.** Ни для `SCStream`, ни для `CGDisplayStream`. Это надо считать неизвестным и проверять на
живой машине, а не предполагать.

Что Apple про запертый экран всё-таки говорит: интерфейс блокировки и входа рисует **SecurityAgent**,
и сторонний код там не может даже показать своё —
[`SFAuthorizationPluginView`](https://developer.apple.com/documentation/securityinterface/sfauthorizationpluginview):
«*By subclassing the SFAuthorizationPluginView class, you avoid changing or duplicating the
Apple-provided authentication or login window dialogs*». Плюс бытовое, но важное:
«*Locking the screen doesn't prevent other users from turning off the Mac, restarting it, and logging
in*» ([Require a password after waking your Mac](https://support.apple.com/guide/mac-help/require-a-password-after-waking-your-mac-mchlp2270/mac)).

Документированные коды ошибок потока —
[`SCStreamError.Code`](https://developer.apple.com/documentation/screencapturekit/scstreamerror/code):
`userStopped` («*the user stopped the stream*»), `userDeclined` («*the user didn't grant Screen
Recording permission*»), `systemStoppedStream` («*the system stopped the stream*»), `noCaptureSource`,
`noDisplayList` («*a stream doesn't have displays available*»), `failedToStart`, `missingEntitlements`,
`internalError`. Строки вида «screen capture not authorized» и числовые значения кодов Apple **не
публикует** — на них опираться нельзя.

Про старые API: «*Applications utilizing deprecated APIs for content capture such as
`CGDisplayStream` & `CGWindowListCreateImage` can trigger system alerts indicating they might be able
to collect detailed information about the user. Developers need to migrate to `ScreenCaptureKit`*»
([macOS 15 Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)).

**Как определить, что экран заперт.** Здесь надо поправить распространённое заблуждение.
`CGSessionCopyCurrentDictionary()` документирован: «*Returns information about the caller's window
server session… or `NULL` if the caller is not running within a Quartz GUI session*»
([ссылка](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary())).
Но документированных ключей ровно **пять**: `kCGSessionUserIDKey`, `kCGSessionUserNameKey`,
`kCGSessionConsoleSetKey`, **`kCGSessionOnConsoleKey`** («*whether the session is on a console*»),
`kCGSessionLoginDoneKey`
([Window Server Session Properties](https://developer.apple.com/documentation/coregraphics/window-server-session-properties)).
Ключа **`CGSSessionScreenIsLocked` в документации Apple нет** — он приватный (и пишется с двумя `S`,
в отличие от документированного `kCGSessionOnConsoleKey`). Уведомления
`com.apple.screenIsLocked`/`…Unlocked` Apple тоже не документирует. Документированные
`NSWorkspace.sessionDidResignActiveNotification` («*before a user session switches out*») и
`screensDidSleepNotification` («*when the device's screen goes to sleep*») означают **не блокировку**,
а смену пользователя и сон экрана.

Практический вывод: **надёжного документированного способа спросить «заперт ли экран» на macOS у
Argus нет.** Есть `kCGSessionOnConsoleKey` (владеет ли сеанс консолью) и есть твёрдый критерий из
§1.6 — меняются ли кадры.

### 4.3 Разрешения TCC: что можно выдать заранее, а что нельзя

**Захват экрана — нельзя.** Это прямая цитата из документации payload'а PPPC про сервис
`ScreenCapture`: «*Allows the application to capture (read) the contents of the system display.
**A profile can't grant access to the contents; it can only deny it.***»
([PPPC Services](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services)).
То есть **MDM/PPPC-профиль не может выдать Screen Recording заранее** — ответ на вопрос
«можно ли обойтись без человека» отрицательный и он задокументирован. Максимум, что даёт профиль:
`Authorization: AllowStandardUserToSetSystemService` — «*Allows a standard (non-admin) user to
configure the permissions… only valid for the `ListenEvent` and `ScreenCapture` services*»
([Services.Identity](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services/identity)).
Это снимает требование прав администратора, но **не** сам клик пользователя.

Сопутствующее, что стоит знать:

- Разрешение спрашивается при первом запуске, и «*After you grant permission, **you need to restart
  the app** to enable capture*»
  ([Capturing screen content in macOS](https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos)).
  Для провижининга это значит: после согласия агент надо перезапустить, иначе он будет «молчать» при
  выданном разрешении.
- Гейты в коде: `CGPreflightScreenCaptureAccess()` / `CGRequestScreenCaptureAccess()` (10.15+) —
  Apple публикует только подписи, без описания.
- **Ввод — можно выдать заранее.** Нужный сервис называется не `Accessibility`, а **`PostEvent`**:
  «*Specifies the policies for the application to use CoreGraphics APIs to send CGEvents to the
  system event stream*», и он **allow-capable**: `Allowed: true` → «*The user isn't prompted and can't
  change this value*». А вот `Accessibility` доживает: «*This profile deprecated its ability to grant
  access as of macOS 26.2, and removes that ability in macOS 27.0*» (там же) → на будущее это
  декларативная конфигурация `com.apple.configuration.app-settings`.
- **Как профиль опознаёт неупакованный Go-бинарь:** «*Application bundles must be identified by
  bundle ID. **Nonbundled binaries must be identified by installation path.***»; `CodeRequirement`
  берётся из `codesign -display -r -`; `StaticCode: true` — если процесс инвалидирует свою
  динамическую подпись. При конфликте настроек «*the most restrictive setting (deny) is used*», а сам
  профиль через MDM требует supervision
  ([PPPC payload](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol),
  [PPPC payload settings](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web)).
- Для VNC-подобных продуктов есть entitlement
  [`com.apple.developer.persistent-content-capture`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
  (macOS 14.4+): «*enables VNC apps to view and record the screen*», но «*request permission to use
  it by submitting the Persistent Content Capture Entitlement Request form*» — то есть по заявке в
  Apple. Что он снимает периодический повторный запрос — Apple **не** утверждает.

### 4.4 Разблокировать macOS удалённо

**Способа нет.** Подтверждается структурно и «по отсутствию»: в наборе MDM-команд есть
[`DeviceLockCommand`](https://developer.apple.com/documentation/devicemanagement/devicelockcommand)
(«*The command to remotely and immediately lock a device*»), и **парной команды разблокировки экрана
не существует**; `UnlockUserAccountCommand` снимает блокировку учётной записи после неудачных
попыток пароля, а не замок экрана. Аутентификация на замке идёт через SecurityAgent, куда сторонний
код не встраивается (§4.2).

Что есть рядом и чем это НЕ является:

- **FileVault по SSH — это разблокировка ТОМА, а не экрана.** «*On a Mac with Apple silicon with
  macOS 26 or later, FileVault can be unlocked over `ssh` after a restart if Remote Login is turned
  on and a network connection is available*»
  ([Apple Platform Security — Managing FileVault](https://support.apple.com/guide/security/managing-filevault-sec8447f5049/web),
  то же в [Intro to FileVault](https://support.apple.com/guide/deployment/intro-to-filevault-dep82064ec40/web)).
  Приводит машину **к окну входа**, не в сеанс.
- **`fdesetup authrestart`** (одноразовый проход pre-boot-разблокировки через перезагрузку) описан
  только в man-странице на самой машине —
  [`fdesetup(8)`](https://keith.github.io/xcode-man-pages/fdesetup.8.html); на сайтах Apple его
  семантики нет, официальная страница лишь предлагает «*enter `man fdesetup`*»
  ([Manage FileVault with device management](https://support.apple.com/guide/deployment/manage-filevault-with-device-management-dep0a2cb7686/web)).
- **Автовход** — единственный документированный способ получить сеанс без человека, и он несовместим
  с шифрованием: «*When FileVault is turned on, automatic login is disabled*»; «*Automatic login
  allows anyone to access your Mac simply by restarting it*»
  ([Set a login window start](https://support.apple.com/guide/mac-help/a-login-window-start-mac-mchlp1158/mac)).
  Через MDM — payload [`com.apple.loginwindow`](https://developer.apple.com/documentation/devicemanagement/loginwindow):
  `AutologinUsername` («*The user short name for an existing user to set up auto login*») и
  `AutologinPassword` («*must match the `AutologinUsername` user's current password*»), macOS 14+,
  **только supervised**
  ([Login window payload settings](https://support.apple.com/guide/deployment/login-window-payload-settings-dep2a822b29/web)).
- **Apple Watch / Touch ID** — по построению локальные и проксимити-зависимые, удалённого аналога
  Apple не документирует; первый вход после загрузки всё равно требует ввода пароля
  ([Unlock your Mac with Apple Watch](https://support.apple.com/guide/mac-help/unlock-your-mac-with-apple-watch-mchl4f800a42/mac)).

### 4.5 Штатное Screen Sharing / Remote Management — что из него выжимается

- **Включить его удалённо нельзя** (в отличие от SSH): «*In macOS 12.1 or later, Screen Sharing can't
  be enabled by the `kickstart` command-line tool. You can use a mobile device management (MDM)
  solution to enable Remote Management*»; а на 10.14+ включённое через kickstart «*Screen Sharing
  gives you view-only access*»
  ([Enable remote management](https://support.apple.com/guide/remote-desktop/enable-remote-management-apd8b1c65bd/mac)).
  Выключить — можно (`kickstart -deactivate`).
- **SSH включается удалённо**: `systemsetup -setremotelogin ( on | off )`
  ([About systemsetup](https://support.apple.com/guide/remote-desktop/about-systemsetup-apd95406b8d/mac)).
- **Screen Sharing и Remote Management взаимоисключающи**: «*You can't have both Screen Sharing and
  Remote Management on at the same time*»
  ([Mac help](https://support.apple.com/guide/mac-help/mh11848/mac)).
- **«Connect to a virtual display»** — документированный способ получить СВОЙ сеанс, не тревожа того,
  кто за машиной: «*You see only the desktop of the user account you used to authenticate*»; «*If
  another user is logged in… the other user can continue using the computer uninterrupted*»
  ([Choose how to control and observe](https://support.apple.com/guide/remote-desktop/choose-how-to-control-and-observe-apd4f46319e/mac)).
  Это macOS-аналог RDP-логики: новый сеанс, а не вид на монитор.
- **High Performance screen sharing** (Apple silicon + macOS 14+): «*If you authenticate using the
  name of the user logged in to the target Mac, **the hardware displays connected to that Mac are
  blanked** … no one can use that Mac while you're using High Performance screen sharing*»
  ([ссылка](https://support.apple.com/guide/remote-desktop/use-high-performance-screen-sharing-apdf8e09f5a9/mac)).
- Работает ли штатное Screen Sharing на самом окне входа — **Apple нигде не пишет**. В «не проверил».

---

## 5. ВЫВОД: единая логика Argus

### 5.1 Как определять состояние — одна команда на ОС

**Linux** (по SSH, работает из голого окружения — проверено под `env -i`):

```bash
loginctl show-session $(loginctl list-sessions --no-legend | awk '{print $1}') \
  -p Id -p Name -p Type -p Class -p Active -p State -p Remote -p LockedHint -p CanLock -p Seat
```

Блоки разделены пустой строкой, каждый начинается с `Id=`. Фильтр — §1.1. **Одна мина:** если сеансов
нет вообще, подстановка отдаст пустую строку, а `show-session` без аргументов печатает свойства
МЕНЕДЖЕРА, а не сеанса («*If no argument is specified, properties of the manager will be shown*»,
[`loginctl(1)`](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)) — то есть
«никто не вошёл» без явной проверки на пустой список превратится в правдоподобный мусор.
Дополнительная проверка блокировщика:
`env XDG_RUNTIME_DIR=/run/user/<uid> busctl --user call org.freedesktop.ScreenSaver /org/freedesktop/ScreenSaver org.freedesktop.ScreenSaver GetActive`.

**Windows** (по SSH): `query session` — состояние `Active`/`Disc`; для флага блокировки нужен
`WTSSessionInfoEx` (§3.6), то есть либо PowerShell с P/Invoke, либо пусть об этом сообщает сам агент
по `WM_WTSSESSION_CHANGE`. Второе честнее и дешевле.

**macOS** (по SSH): дешёвая проверка «есть ли вообще консольный GUI-сеанс» —
`stat -f%Su /dev/console` (кто владеет консолью) и/или наличие процесса `loginwindow` у пользователя.
Документированного запроса «заперт ли экран» нет (§4.2): `kCGSessionOnConsoleKey` отвечает на другой
вопрос, а приватные ключи и уведомления Apple не публикует. Значит для macOS **основной критерий —
кадры**, а состояние «никто не вошёл» определяется по владельцу `/dev/console`.

Общий принцип, уже принятый в Argus: **состояние определяется по ответу, а не по нашим ожиданиям**,
и один промах опроса даёт «не знаю», а не «выключено».

### 5.2 Таблица: состояние машины × ОС → что делает Argus

| Состояние | Linux | Windows | macOS |
|---|---|---|---|
| **Экран открыт, сеанс активен**<br>*(признак: `Class=user`+`State=active`+`LockedHint=no` / `WTSActive`+`WTS_SESSIONSTATE_UNLOCK` / владелец `/dev/console` = владелец + идут кадры)* | открыть агент | открыть агент | открыть агент |
| **Сеанс есть, экран заперт**<br>*(признак: `LockedHint=yes` / `WTS_SESSIONSTATE_LOCK` / на macOS — только «кадры не меняются», документированного запроса нет)* | **снять замок по SSH**: `loginctl unlock-session <ID>` от имени владельца сеанса → ждать `LockedHint=no` ≤3с (и/или `ScreenSaver.GetActive=false`) → открыть агент. Не сработало (Sway и т.п.) → сказать «среда проигнорировала разблокировку», не выдавать за успех | **разблокировать нечем — API нет** (§3.4). Пути: (1) сказать прямо «экран заперт» — агент отдаёт застывший/чёрный кадр; (2) упасть на RDP с паролем ОС: сеанс разблокируется, но переедет к нам и уйдёт с монитора; вернуть на монитор — `tscon` (§3.5в) | **разблокировать нечем — API нет** (§4.4). Сказать прямо «экран заперт». Вариант: Screen Sharing/ARD с паролем владельца, но это возвращает пароль ОС в цепочку, а «virtual display» даёт свой сеанс, не вид на монитор (§4.5) |
| **Сеанс есть, но не на переднем плане**<br>*(`Active=no`/`State=online`; на macOS — быстрая смена пользователя)* | `loginctl activate <ID>` — **от root**; у обычного пользователя по SSH прав, скорее всего, не хватит (§1.7) | не наблюдается: у клиентских редакций один интерактивный сеанс | вернуть чужой сеанс на консоль удалённо нечем → сказать честно; свой сеанс — через «connect to a virtual display» (§4.5) |
| **Монитор погашен**<br>*(замка нет, кадры не меняются)* | `kscreen-doctor --dpms on` либо толчок мышью через `/dev/uinput` (у агента уже есть) | толчок мышью через `SendInput` (у агента уже есть) | толчок требует `CGEvent` (у агента нет — нужен cgo); разрешение `PostEvent` выдаётся профилем заранее (§4.3). Пока — сказать честно |
| **Никто не вошёл**<br>*(подходящих сеансов ноль, при этом агент жив и отвечает на `/health` — это НЕ «машина выключена»)* | **сказать прямо: «в машину никто не вошёл, экрана нет»**; предложить владельцу автовход (§2.3). Экспериментально — root-`kmsgrab` (§2.2, не проверен). Штатного способа показать greeter НЕТ | **упасть на RDP**, понимая, что это НОВЫЙ сеанс с паролем ОС, а не вид на монитор (§3.5а). Нет RDP (Home) — сказать «никто не вошёл» | сказать прямо «никто не вошёл». Поддерживаемый путь существует, но требует переделки: pre-login-агент `LimitLoadToSessionType=[Aqua, LoginWindow]` + ScreenCaptureKit, macOS 14.4+, подпись, не Go (§4.1). Либо MDM-автовход (supervised, macOS 14+, **несовместим с FileVault**, §4.4) |
| **Агент не отвечает, SSH живой** | это состояние агента, а не экрана: перезапустить службу, при повторе — переустановить | то же (задача планировщика могла не подняться; Smart App Control) | то же (LaunchAgent мог не загрузиться; либо не выдан Screen Recording — после выдачи агент надо ПЕРЕЗАПУСТИТЬ, §4.3) |
| **SSH не отвечает** | «не знаю» с первого промаха, «выключено» — со второго (правило уже принято в Argus) | то же | то же |

### 5.3 Что из этого стоит поменять в коде (не менял, это разбор)

1. **Провижининг Linux не включает linger.** В `src/main/agent.ts` юнит ставится
   (`systemctl --user enable/restart`), но `loginctl enable-linger` не вызывается — на стенде linger
   был включён вручную. Без него агент не поднимется до входа владельца в графику, и различить
   «никто не вошёл» от «машина мертва» станет нечем.
2. **Перед открытием экрана нужен шаг «проба состояния»** (§5.1) — сейчас в `src/main/` нет ни
   `loginctl`, ни `query session`. Пользы больше всего от него в двух клетках: «заперто» (снять
   замок) и «никто не вошёл» (честный текст вместо ошибки соединения).
3. **Формулировку про `kmsgrab` в `agent/README.md` стоит уточнить**: документация ffmpeg разрешает
   `CAP_SYS_ADMIN` как альтернативу DRM-мастеру (§2.2) — это открывает root-путь к экрану
   блокировки и greeter'у, который сейчас в проекте описан как невозможный.
4. **Отчёт агента о блокировке.** На Windows у агента есть штатный механизм узнать о
   блокировке первым (`WM_WTSSESSION_CHANGE`, §3.6) — дешевле, чем опрашивать по SSH.
5. **macOS: экран входа нынешней формой агента не покрывается никогда** (LaunchAgent живёт в
   `Aqua`-сеансе, которого при отсутствии входа нет). Если эта клетка нужна — это отдельная работа:
   pre-login-агент на Swift/Obj-C с `LimitLoadToSessionType=[Aqua, LoginWindow]` и ScreenCaptureKit,
   macOS 14.4+ (§4.1). Решение «делать / не делать», а не багфикс.
6. **macOS: после выдачи Screen Recording агент надо перезапустить** — документация Apple говорит это
   прямо (§4.3). Провижининг делает `launchctl unload && load` один раз, ДО того как владелец нажмёт
   «Разрешить», поэтому первый запуск закономерно окажется без прав. Нужен повторный `load` (либо
   `launchctl kickstart -k gui/<uid>/com.argus.agent`) после согласия.
7. **Общий вывод по трём ОС в одну строку:** экран **заблокированной** машины Argus честно получает
   только на Linux (`unlock-session`, без пароля). На Windows и macOS замок снимается лишь
   предъявлением пароля, а экран **входа** не показывает ни одна из трёх ОС нынешней архитектурой
   агента. Значит правильное поведение Argus в этих клетках — **говорить как есть**, а не изображать
   сбой связи.

---

## ЧЕГО Я НЕ ПРОВЕРИЛ

Список честный: всё, что ниже, — либо не подтверждено первоисточником, либо не проверено на живой
машине. Ни на что из этого нельзя опираться как на факт.

**Linux**

1. **Даёт ли `kmsgrab` под `CAP_SYS_ADMIN` кадры на живом сеансе KDE/Wayland и на экране
   приветствия.** Документация ffmpeg разрешает («*either DRM master or CAP_SYS_ADMIN*»), но на
   стенде не пробовалось. Плюс отдельно не проверено, импортируется ли DMA-BUF на проприетарном
   драйвере NVIDIA (у владельца RTX 3060). **Это первое, что стоит проверить.**
2. **Продолжает ли портальный поток PipeWire отдавать кадры на заблокированном KDE-сеансе.**
   Собственная вики KWin говорит, что при блокировке композитор перестаёт перерисовывать
   ([KWin/Screenlocker](https://community.kde.org/KWin/Screenlocker)), но страница описывает более
   старую архитектуру, и на Plasma 6.6 это не проверялось.
3. **`loginctl activate <ID>` по SSH.** Вывод «обычному пользователю не хватит прав, root пройдёт»
   получен из policy-файла и кода, живьём не проверялся.
4. **Имена ключей автовхода у `plasma-login-manager`** (Plasma 6.6). Файл найден —
   `/etc/plasmalogin.conf` (по строкам KAuth-помощника, который его пишет), но точные ключи и секции
   не подтверждены: man-страницы у пакета нет, а в бинаре видны только слова `autologin`, `user`,
   `session`. Совместимость с SDDM-форматом `[Autologin] User=/Session=/Relogin=` — предположение.
5. **Захват X11-greeter через `XAUTHORITY` дисплей-менеджера.** Путь к файлу нигде не документирован.
6. **Поведение `loginctl unlock-session` в средах кроме KDE/GNOME/Sway** (XFCE, Cinnamon, i3lock и
   прочие) — не смотрел исходники.
7. **Гасит ли DPMS портальный поток** (кадры стоят, потому что монитор выключен) — предполагается, не
   проверено.
8. **Отвечает ли агент на `/health`, когда в графику никто не вошёл** (§2.1). Вывод сделан из
   семантики юнита (`WantedBy=default.target` + `linger`), живьём в этом состоянии не снималось. Это
   ключевая клетка таблицы — проверить вторым делом после `kmsgrab`.

**Windows** (живой машины в разборе не было; всё — по документации)

9. Что именно возвращает `WTSQueryUserToken`, когда никто не вошёл: страница говорит только
   «*returns zero*»; код `ERROR_NO_TOKEN` (1008) — из форумов, не из документации.
10. Требует ли `SetTokenInformation(TokenSessionId)` для ЧУЖОЙ сессии `SE_TCB_NAME` — на странице
    функции этого нет.
11. Запуск процесса на `winsta0\Winlogon` через `CreateProcessAsUser` — документация санкционирует
    только `winsta0\default`; путь через Winlogon-стол не описан и, судя по DACL, для токена
    пользователя закрыт.
12. Поведение `Windows.Graphics.Capture` на защищённом рабочем столе — **в документации нет**,
    конкретный код ошибки утверждать нельзя.
13. Явного утверждения «`BitBlt` не читает экран блокировки» в документации нет — вывод сделан из
    изоляции оконных станций и рабочих столов.
14. `AutoLogonCount` — на официальной странице про AutoAdminLogon отсутствует.
15. Одна чеканная цитата про «локальная консоль отключается/запирается, когда тот же пользователь
    зашёл по RDP на клиентской редакции» не найдена — вывод собран из ограничения «один
    интерактивный сеанс» и определения `WTSDisconnected`.
16. Приём `tscon <id> /dest:console` (вернуть сеанс на монитор) в официальных примерах не показан.
17. Не открывались (только цитируются): `WTSGetActiveConsoleSessionId`, `WTSEnumerateSessions`,
    `WM_WTSSESSION_CHANGE`, `query session`, страница про credential providers.

**macOS** (живой машины нет; всё — по документации Apple и ответам инженеров Apple DTS на форуме)

18. **Что именно отдаёт захват на заблокированном (но вошедшем) macOS — Apple не документирует
    вообще.** Ни для `SCStream`, ни для `CGDisplayStream`. Ни одного утверждения на эту тему в
    разборе делать нельзя, надо мерить.
19. **Периодический повторный запрос разрешения на запись экрана в macOS 15+** (неделя/месяц) —
    Apple его не документирует нигде: ни в релиз-нотах, ни в guide. Наблюдаемое поведение, не факт.
    И **не подтверждено**, что entitlement `persistent-content-capture` его снимает — это вывод
    разработчиков, а не заявление Apple.
20. **Ключ `CGSSessionScreenIsLocked` и уведомления `com.apple.screenIsLocked` — приватные**, в
    документации Apple их нет. Документированный ключ пишется `kCGSessionOnConsoleKey` (одна `S`) и
    значит другое.
21. **Работает ли штатное Screen Sharing / ARD на окне входа** — Apple об этом не пишет ни в Remote
    Desktop User Guide, ни в Platform Deployment. Проверять на железе.
22. **`stat -f%Su /dev/console` как способ узнать консольного пользователя** — практика, а не
    документированный Apple интерфейс.
23. **`fdesetup authrestart`** описан только man-страницей на самой машине; на сайтах Apple его нет,
    и DTS отказался подтверждать его свойства безопасности.
24. `com.apple.login.mcx.DisableAutoLoginClient` и `autoLoginUser` — в документации Apple как
    свойства с описанием **отсутствуют** (первое встречается только внутри XML-примера).
25. Числовые значения `SCStreamError.Code` Apple не публикует — привязываться к ним нельзя.
26. Поддерживаются ли `ScreenCapture`/`Accessibility` внутри декларативного `PermissionDefaults`
    (macOS 27) — не подтверждено; в примерах Apple только `Camera`/`Microphone`/`Location`. И там же
    ограничение «*Only AppKit-based apps on macOS support this feature*», что для голого Go-бинаря,
    скорее всего, значит «не поддерживается».
27. Требование Full Disk Access для `systemsetup -setremotelogin on` (10.14+) — Apple не документирует.

**Общее**

28. Ни одна из рекомендаций §5.3 не реализована и не протестирована — код в этой работе не менялся.
29. Таблица §5.2 не проверена целиком на живом стенде: подтверждены живьём только Linux-клетки
    «сеанс активен» и «заперто → `unlock-session` без пароля». Все Windows- и macOS-клетки — вывод из
    документации.

---

## Источники

**systemd / logind / polkit**

- [`loginctl(1)`](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html) ·
  [`org.freedesktop.login1(5)`](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html) ·
  [`sd_session_is_active(3)`](https://www.freedesktop.org/software/systemd/man/latest/sd_session_is_active.html) ·
  [`sd_bus_query_sender_creds(3)`](https://www.freedesktop.org/software/systemd/man/latest/sd_bus_query_sender_creds.html) ·
  [`polkit(8)`](https://www.freedesktop.org/software/polkit/docs/latest/polkit.8.html)
  (все читались с самой машины из пакета `systemd 260.2-2-arch`)
- Исходники: [`logind-session-dbus.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-session-dbus.c) ·
  [`logind-dbus.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-dbus.c) ·
  [`logind-polkit.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-polkit.c) ·
  [`logind-user.c`](https://github.com/systemd/systemd/blob/main/src/login/logind-user.c) ·
  [`logind-session.h`](https://github.com/systemd/systemd/blob/main/src/login/logind-session.h) ·
  [`bus-polkit.c`](https://github.com/systemd/systemd/blob/main/src/shared/bus-polkit.c) ·
  [`bus-polkit.h`](https://github.com/systemd/systemd/blob/main/src/shared/bus-polkit.h)
- `/usr/share/polkit-1/actions/org.freedesktop.login1.policy` (файл с машины)

**Рабочие среды**

- KDE: [`ksldapp.cpp`](https://invent.kde.org/plasma/kscreenlocker/-/blob/master/ksldapp.cpp) ·
  [KWin/Screenlocker](https://community.kde.org/KWin/Screenlocker)
- GNOME: [`screenShield.js`](https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/screenShield.js) ·
  [Configure automatic login](https://help.gnome.org/admin/system-admin-guide/stable/login-automatic.html.en) ·
  [gnome-remote-desktop README](https://github.com/GNOME/gnome-remote-desktop/blob/main/README.md)
- Sway: [`swayidle(1)`](https://github.com/swaywm/swayidle/blob/master/swayidle.1.scd) ·
  [`swaylock(1)`](https://github.com/swaywm/swaylock/blob/master/swaylock.1.scd)
- [`sddm.conf(5)`](https://man.archlinux.org/man/sddm.conf.5) (читалась с машины, sddm 0.21.0)

**Захват**

- [xdg-desktop-portal ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) ·
  [ffmpeg-devices: kmsgrab / x11grab](https://ffmpeg.org/ffmpeg-devices.html#kmsgrab)

**Windows (Microsoft Learn)**

- [Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services) ·
  [Window Stations](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations) ·
  [Desktops](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops) ·
  [Session 0 isolation (whitepaper)](https://learn.microsoft.com/en-us/previous-versions/windows/hardware/design/dn653293(v=vs.85))
- [`WTSQueryUserToken`](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken) ·
  [`WTSGetActiveConsoleSessionId`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-wtsgetactiveconsolesessionid) ·
  [`DuplicateTokenEx`](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-duplicatetokenex) ·
  [`SetTokenInformation`](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-settokeninformation) ·
  [`CreateProcessAsUser`](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)
- [`AcquireNextFrame`](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe) ·
  [Screen capture (WGC)](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [`LockWorkStation`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation) ·
  [Turn on automatic logon](https://learn.microsoft.com/en-us/troubleshoot/windows-server/user-profiles-and-logon/turn-on-automatic-logon) ·
  [ARSO](https://learn.microsoft.com/en-us/windows-server/security/windows-authentication/winlogon-automatic-restart-sign-on-arso) ·
  [`shutdown`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown)
- [Configure NLA](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2008-R2-and-2008/cc732713(v=ws.11)) ·
  [`tscon`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tscon) ·
  [Enable Remote Desktop](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access) ·
  [`query session`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/query-session)
- [`WTS_CONNECTSTATE_CLASS`](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ne-wtsapi32-wts_connectstate_class) ·
  [`WTSINFOEX_LEVEL1`](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w) ·
  [`WM_WTSSESSION_CHANGE`](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)

**macOS (Apple)**

- Архитектура сеансов и pre-login: [TN2083 Daemons and Agents](https://developer.apple.com/library/archive/technotes/tn2083/_index.html) ·
  [PreLoginAgents (пример кода)](https://developer.apple.com/library/archive/samplecode/PreLoginAgents/Introduction/Intro.html) ·
  ответы Apple DTS: [thread 814152](https://developer.apple.com/forums/thread/814152) (актуальный) ·
  [thread 768146](https://developer.apple.com/forums/thread/768146) ·
  [thread 756908](https://developer.apple.com/forums/thread/756908) (устаревший, противоречит 814152)
- Захват: [`SCStreamError.Code`](https://developer.apple.com/documentation/screencapturekit/scstreamerror/code) ·
  [Capturing screen content in macOS](https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos) ·
  [`CGRequestScreenCaptureAccess()`](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess()) ·
  [macOS 15 Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes) ·
  [`com.apple.developer.persistent-content-capture`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.persistent-content-capture)
- Состояние сеанса: [`CGSessionCopyCurrentDictionary()`](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()) ·
  [Window Server Session Properties](https://developer.apple.com/documentation/coregraphics/window-server-session-properties) ·
  [`sessionDidResignActiveNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/sessiondidresignactivenotification) ·
  [`screensDidSleepNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/screensdidsleepnotification)
- Ввод и TCC: [`CGEvent.post(tap:)`](https://developer.apple.com/documentation/coregraphics/cgevent/post(tap:)) ·
  [PPPC payload](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol) ·
  [PPPC Services](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services) ·
  [Services.Identity](https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol/services/identity) ·
  [PPPC payload settings](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web) ·
  [`AppSettings` (DDM, macOS 27)](https://developer.apple.com/documentation/devicemanagement/appsettings)
- Замок, вход, автовход: [`SFAuthorizationPluginView`](https://developer.apple.com/documentation/securityinterface/sfauthorizationpluginview) ·
  [Require a password after waking](https://support.apple.com/guide/mac-help/require-a-password-after-waking-your-mac-mchlp2270/mac) ·
  [`DeviceLockCommand`](https://developer.apple.com/documentation/devicemanagement/devicelockcommand) ·
  [`LoginWindow` payload](https://developer.apple.com/documentation/devicemanagement/loginwindow) ·
  [Login window payload settings](https://support.apple.com/guide/deployment/login-window-payload-settings-dep2a822b29/web) ·
  [Set a login window start](https://support.apple.com/guide/mac-help/a-login-window-start-mac-mchlp1158/mac) ·
  [Unlock your Mac with Apple Watch](https://support.apple.com/guide/mac-help/unlock-your-mac-with-apple-watch-mchl4f800a42/mac)
- FileVault: [Apple Platform Security — Managing FileVault](https://support.apple.com/guide/security/managing-filevault-sec8447f5049/web) ·
  [Intro to FileVault](https://support.apple.com/guide/deployment/intro-to-filevault-dep82064ec40/web) ·
  [Manage FileVault with device management](https://support.apple.com/guide/deployment/manage-filevault-with-device-management-dep0a2cb7686/web) ·
  [`fdesetup(8)`](https://keith.github.io/xcode-man-pages/fdesetup.8.html) ·
  [`apple_ssh_and_filevault(7)`](https://keith.github.io/xcode-man-pages/apple_ssh_and_filevault.7.html)
- Screen Sharing / Remote Management: [Enable remote management](https://support.apple.com/guide/remote-desktop/enable-remote-management-apd8b1c65bd/mac) ·
  [About systemsetup](https://support.apple.com/guide/remote-desktop/about-systemsetup-apd95406b8d/mac) ·
  [Screen Sharing vs Remote Management](https://support.apple.com/guide/mac-help/mh11848/mac) ·
  [Choose how to control and observe](https://support.apple.com/guide/remote-desktop/choose-how-to-control-and-observe-apd4f46319e/mac) ·
  [High Performance screen sharing](https://support.apple.com/guide/remote-desktop/use-high-performance-screen-sharing-apdf8e09f5a9/mac) ·
  [Control or observe one client](https://support.apple.com/guide/remote-desktop/control-or-observe-one-client-computer-apd2450a787/mac)
