# 10 · Brand & Visual System  🟦 ENGINE

The brand is sport-neutral and inherited by every sport pack — each pack re-skins **accent imagery only**, never the design language.

## Brand essence

**Editorial / newspaper print, light-first.** NOT a neon sportsbook. Energy comes from a bold red stamp and serif/mono typography, NOT neon gradients. (An early pink/purple/cyan build was wrong and discarded.) Must match the `scorebox.games` family.

> Reconciliation rule: when a brief says "energetic & modern," deliver energy through the **stamp red + serif/mono** system, never through neon.

## Colour tokens

### Light (default)
| Token | Hex | Use |
|-------|-----|-----|
| Paper | `#F4F0E6` | background |
| Card | `#F8F5EC` | surfaces |
| Ink | `#1A1814` | text |
| Stamp red | `#C0241F` (darker `#a91d18`) | the single accent |
| Win | `#1f7a3d` | win results |
| Place | `#9a6b00` | place results |
| Gold | `#caa53d` | medals / highlights |

### Dark
| Token | Hex |
|-------|-----|
| Paper | `#14120F` |
| Card | `#1C1A15` |
| Ink | `#EDE8DB` |
| Stamp red | `#e0473f` |
| Win | `#4fc878` |
| Place | `#d9a637` |
| Gold | `#e0bb52` |

Theme: **light (paper) default + dark toggle** (`document.documentElement.classList.toggle('dark')`), with a 🌙/☀️ switch.

## Typography

| Role | Typeface |
|------|----------|
| Headlines | **Source Serif 4** |
| Body | **Inter** |
| Numbers / odds / points | **JetBrains Mono** |

Numbers always in the mono face — it's the "scoreboard" voice and makes the always-open maths legible.

## Form-dot colour language  🟥 PACK (racing) but the pattern generalises

- Gold = win · silver/amber = place (top 3) · grey = unplaced.

## Layout & motion

- **430px centred mobile frame**, bottom-nav app shell, viewport locked (`maximum-scale=1.0`).
- **4-tab shell:** Today · Results · League · Chat. Rivalry is a sub-view under League.
- **Motion philosophy: calm.** High-stakes but not alarmist — deadline countdowns change colour, they don't bounce or stick. At most a brief win/place celebration (confetti) on a result. No gratuitous animation.

## Per-sport re-skin guidance

A new sport pack keeps the entire system above and changes only: accent imagery (silks → kit colours → car liveries), the form-dot/result iconography for that sport, and copy nouns. The masthead, stamp, type kit, tokens and motion philosophy stay identical — that's what makes the family feel like one product.

## Known placeholder

- The ☾ crescent mark is a **placeholder** — replace with the final brand mark.
