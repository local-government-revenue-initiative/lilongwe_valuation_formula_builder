# AMALI Brand Reference

Extracted from `260722Presentation to LCC.pptx` (Lilongwe City Council Visit deck). Use this as the source of truth for AMALI-related graphics, plots, and documents.

## Colors

| Role | Hex | Notes |
|---|---|---|
| Primary green | `#14472E` | Dominant dark green fill — callout/card backgrounds |
| Secondary green | `#196B24` | Lighter green accent, used sparingly |
| Primary gold | `#E8A838` | Most-used accent — underlines, bullets, icon fills |
| Logo gold | `#F0AB00` | Exact gold in the AMALI wordmark |
| Bright gold/amber | `#FFC000` | Highlight variant (icons, emphasis) |
| Teal | `#00685B` | Logo tagline color on light backgrounds |
| Navy | `#192C59` | Secondary text/bullet accent |
| Navy light | `#2A3D5C` | Secondary panel/text accent |
| Cream | `#F8EDCA` | Icon circle backgrounds |
| Mint background | `#EAF2EA` | Light panel/box background |
| Slate background | `#C8D3E0` | Light panel/box background (blue-gray) |
| Black | `#000000` | Headings, body text |
| White | `#FFFFFF` | Text on dark/green backgrounds |

**Suggested categorical order** (for charts with multiple series): primary green → primary gold → teal → navy → bright gold → secondary green.

## Fonts

- **Headings/display:** Raleway (bold) — all slide titles and emphasis text
- **Body:** Arial — bullet/body copy
- Occasional use of Avenir and Calibri, but not core to the brand

Raleway is a free Google Font (not always preinstalled) — in R, load it with `sysfonts::font_add_google("Raleway")` + `showtext`; in other tools, download from fonts.google.com or substitute a similar geometric sans (e.g., Poppins, Montserrat) if unavailable.

## Logo

Two lockups extracted, both included in this folder:

- `amali_logo_gold_on_dark.png` — gold wordmark + white tagline ("Catalysing the transformation of cities in Africa"). Use on dark/green backgrounds.
- `amali_logo_gold_teal_on_light.png` — gold wordmark + teal tagline ("African Mayoral Leadership Initiative"). Use on white/light backgrounds.

## Visual style notes

- Title slides: full-bleed photo with a dark green duotone/color overlay, white bold Raleway headline, gold underline rule.
- Content slides: white background, bold black Raleway headline, colored callout boxes (green-fill or mint-background) with rounded corners for key quotes/points.
- Icons: flat, single-color (gold, cream, or black), simple geometric style.

## Companion file

`amali_theme.R` — a ready-to-source ggplot2 theme and color palette (ties into tidyverse conventions) so plots automatically match this branding.
