# Argus — Design Contract (Graphite & Ember)

> Source of truth UI. Полный спек редизайна: `docs/REDESIGN-2026-07.md`.
> Токены: `design/tokens.json` + `src/renderer/src/assets/main.css` (`@theme`).

## §1 Intent
- One phrase: **a personal command center for servers, money, subscriptions, devices & AI**.
- Emotion: «тихий пост наблюдения» — calm control + premium trust, тепло и дорого.
- Audience: владелец (technical power-user). Single-user, local-first desktop.

## §2 Aesthetic
- Family: **warm premium-dark («Graphite & Ember»)**, эталон — `assets/concepts/concept-c2-graphite-ember.png`.
- Изометрический иллюстрационный слой (30°, тёмный пьедестал, ember-свечение) — см. спек §2.3.
- Один янтарный акцент; свечение — только у активных/online элементов; без неона и стекла.

## §3 Tokens
| token | value | роль |
|---|---|---|
| bg | `#121110` | фон приложения |
| surface | `#1a1816` | sidebar / рейлы |
| card | `#201d1a` | карточки |
| card-hover | `#262220` | ховер |
| border | `#2a2622` | hairlines |
| accent | `#f59e0b` | ember: CTA, активная навигация, ссылки |
| accent-hover | `#d97706` | ховер акцента |
| glow | `rgba(245,158,11,.14)` | пьедесталы/hover-свечение |

Текст: заголовки white, body stone-300 `#d6d3d1`, лейблы stone-400/500.
`slate-*` классы временно ремапнуты на stone-значения в `@theme` (мост до B2/B3).
Type: Inter Variable; числа `tabular-nums`; моно — ip/пути/терминал. Cards `rounded-xl`; controls `rounded-lg`.

## §4 Статусы (цвет + форма + текст, отвязаны от бренда)
online ● `#10b981` · degraded ▲ `#fbbf24` · rebooting ◔ `#38bdf8` (единственный пульсирует) ·
offline ■ `#f43f5e` · unknown ◇ stone · maintenance ⏸ violet. Нет данных → unknown, не «зелёный».

## §5 Motion
Transitions на hover/статусах; пульс только rebooting; no page scenes; reduce-motion уважается.

## §6 QA checklist
- [ ] Accent-дисциплина: ember только на CTA / активной навигации / ссылках / прогрессе.
- [ ] Статус никогда не красится в accent; online = emerald.
- [ ] Контраст: заголовки white / body stone-300 читаемы на `#121110` (≥4.5:1).
- [ ] `tabular-nums` на всех числах; деньги в родной валюте, тоталы в USD.
- [ ] Скриншот соответствует эталону C2 (тёплый графит, просторные карточки).

## §7 Дизайн-система
Полное самодостаточное описание системы (палитра, физика, каркас, ярлыки, правила честности
данных, тон) — `docs/DESIGN-SYSTEM.md`. По нему собирается
экран, неотличимый от остальных. Правишь дизайн — правь и его, иначе он начнёт врать.
