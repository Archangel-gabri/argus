# Nexus One — Design Contract

> Encodes the approved "Nexus One" visual spec. Source of truth for the UI.
> Tokens live in `design/tokens.json` and `src/renderer/src/assets/main.css` (`@theme`).

## §1 Intent
- One phrase: **a personal command center for servers, money, subscriptions & AI accounts**.
- Emotion: **calm control + premium trust** — a cockpit you rely on, not a toy.
- Audience: the owner (technical power-user). Single-user, local-first desktop app.
- Reference feel: Termius / Linear / Vercel dashboard — dense but breathable, dark, precise.

## §2 Aesthetic
- Leading family: **premium-dark**. Mood word: *cockpit*.
- Flat surfaces with subtle elevation (hairline border + soft shadow); ONE cyan accent, used sparingly.
- No decorative gradients (except the profile avatar), no glassmorphism, no neon overload.

## §3 Tokens (see `design/tokens.json`)
| token | value | role |
|---|---|---|
| bg | `#10141d` | app background |
| surface | `#1a202c` | sidebar / rails |
| card | `#2d3748` | cards, active nav |
| card-hover | `#353f50` | hover |
| border | `#1e293b` | hairlines |
| accent | `#22d3ee` | cyan — logo, icons, progress, links, primary button |
| accent-hover | `#1f96ab` | accent hover |
| text | `slate-300` / `white` | body / headings |

Type: **Inter Variable** (fontsource). Headings semibold white; labels slate-400/500;
numbers `tabular-nums`. Cards `rounded-xl`; controls `rounded-lg`.

## §4 Composition
- Three columns: sidebar `w-64` (fixed) · main list (flex) · insights rail `w-[360px]`.
- Server cards in a responsive 1→2 column grid.
- Cyan is an accent, never a fill for large areas (only the primary CTA + progress fills).

## §5 Motion
- Subtle only: color/background transitions on hover; progress-bar width transition. No page scenes.

## §6 QA checklist
- [ ] Non-generic: real hierarchy, not a bootstrap clone.
- [ ] Contrast: white headings + slate-300 body legible on `#10141d`.
- [ ] Accent discipline: cyan only on logo / active icon / progress / links / primary CTA.
- [ ] Status colours: online = cyan, rebooting = amber, offline = rose.
- [ ] `tabular-nums` for all numbers; money shows native currency, totals normalised to USD.
- [ ] Screenshot matches spec: sidebar groups + badges, card anatomy, Costs + Spend pie.
