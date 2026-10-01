---
name: OpenOutbound brand images
description: The look of the README hero, the architecture diagram, the social card and the mark.
colors:
  dark-bg: "#0a0a0b"
  dark-bg-github: "#0d1117"
  dark-fg: "#ededef"
  dark-fg-2: "#8f8f99"
  dark-fg-code: "#b4b4bc"
  dark-line: "rgb(255 255 255 / 0.08)"
  dark-line-strong: "rgb(255 255 255 / 0.14)"
  dark-panel: "#111113"
  dark-panel-top: "#151518"
  dark-panel-github: "#12161d"
  dark-panel-top-github: "#161b23"
  dark-sunk: "rgb(255 255 255 / 0.035)"
  dark-chip: "rgb(255 255 255 / 0.07)"
  dark-wire: "#5a5a62"
  dark-green: "#3dd68c"
  dark-green-soft: "rgb(61 214 140 / 0.14)"
  dark-amber: "#f5b03d"
  dark-amber-soft: "rgb(245 176 61 / 0.16)"
  dark-room-light: "rgb(226 232 255 / 0.14)"
  dark-edge-light: "rgb(255 255 255 / 0.55)"
  light-bg: "#ffffff"
  light-fg: "#1d1d1f"
  light-fg-2: "#6e6e73"
  light-fg-code: "#4a4a50"
  light-line: "#e8e8ed"
  light-line-strong: "#d2d2d7"
  light-sunk: "#f5f5f7"
  light-wire: "#8e8e93"
  light-green: "#1e8e4e"
  light-green-soft: "rgb(30 142 78 / 0.1)"
  light-amber: "#c47a00"
  light-amber-soft: "rgb(196 122 0 / 0.12)"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "60px"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.038em"
  lockup:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  lead:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.006em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    letterSpacing: "-0.012em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    letterSpacing: "-0.006em"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  code:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "14.5px"
    fontWeight: 400
    letterSpacing: "0"
rounded:
  control: "8px"
  inset: "12px"
  panel: "16px"
  pill: "999px"
spacing:
  gap-tight: "6px"
  gap: "8px"
  gap-lockup: "10px"
  gap-grid: "14px"
  panel-x: "20px"
  canvas-edge: "48px"
components:
  panel:
    backgroundColor: "{colors.dark-panel}"
    rounded: "{rounded.panel}"
    padding: "0 20px"
  approval-row:
    backgroundColor: "{colors.dark-sunk}"
    rounded: "{rounded.inset}"
    padding: "14px 10px"
  button-primary:
    backgroundColor: "{colors.dark-fg}"
    textColor: "{colors.dark-bg}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "32px"
  button-secondary:
    textColor: "{colors.dark-fg}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "32px"
  pill-door:
    textColor: "{colors.dark-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  chip-check:
    backgroundColor: "{colors.dark-chip}"
    textColor: "{colors.dark-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
---

# Design System: OpenOutbound brand images

This file covers the brand images in `assets/`. The single source of the values is `assets/src/tokens.css`. The frontmatter above mirrors it. If they ever disagree, `tokens.css` wins and this file is stale.

## Overview

**Creative North Star: "The Quiet Console"**

The images look like a premium developer tool caught at a calm moment. The owner chose the canon: dark sits next to Linear and Vercel, light sits next to Apple and Notion. Premium, minimal, crisp type, lots of empty space, and light effects you notice only when they are gone.

Every image shows the real product, not a metaphor. The hero is one agent session that ends at a human approval. The diagram is the real engine with its real doors, gate and plug-ins. All names and numbers are true to the code; demo data uses the sandbox workspaces (Northwind Analytics, Brightsmile Dental Supply).

Color is almost absent. Ink, gray and hairlines carry the whole layout. The only hues are two status colors, and they mean something every time they appear.

**Key Characteristics:**
- Monochrome, with green and amber as status only.
- Geist for words, Geist Mono only for real tool names and code.
- One light source in dark; soft offset shadows in light.
- One large panel as the brightest object on the canvas.
- Every image ships in a dark and a light variant (the social card is dark only).

## Colors

A monochrome system with two status colors and no brand hue.

The two themes are separate palettes, not inversions. Pages pick one with `?theme=dark` or `?theme=light`. Dark README images also take `?bg=github`, which swaps in the GitHub page values.

### Status

| Color | Dark | Light | Means |
| --- | --- | --- | --- |
| Done Green | `dark-green` | `light-green` | A step finished, or the engine is live ("Connected over MCP", "Runs 24/7"). |
| Waiting Amber | `dark-amber` | `light-amber` | Waiting on a person. Used on the approval step only. |

Each has a soft partner (`*-soft`) for the filled disc behind the icon.

### Neutral

| Role | Token | Where |
| --- | --- | --- |
| Page | `bg` | Canvas. `#0d1117` on dark README images, pure white in light. |
| Ink | `fg` | Headlines, titles, results, primary button fill in both themes. |
| Second ink | `fg-2` | Lead line, descriptions, secondary labels, the prompt caret. |
| Code ink | `fg-code` | Tool names in Geist Mono. Slightly dimmer than `fg` so the result reads first. |
| Hairline | `line` | Panel border, row dividers, list rules. |
| Strong hairline | `line-strong` | Outlined pills, secondary buttons, the step thread. |
| Panel | `panel`, `panel-top` | Panel fill, graded from `panel-top` down to `panel` over 140px. Both white in light. |
| Sunk | `sunk` | Inset areas: the approval row, the gate band. |
| Chip | `chip` | Filled check chips in the gate. |
| Wire | `wire` | Diagram wires and their end dots. |
| Room light | `room-light` | The radial light behind the content. Transparent in light. |
| Edge light | `edge-light` | The 1px highlight on a panel's top edge. Transparent in light. |

### Named Rules

**The Status Only Rule.** Green means done or live. Amber means waiting on a person. Nothing else gets a hue: no accent color, no colored links, no tinted headings.

**The No Edge Rule.** A dark README image must melt into GitHub's dark page (`#0d1117`). Render dark README images with `bg=github`, and keep every light effect inside the frame so no glow reaches the border. Light images are white on white for the same reason.

## Typography

**Display Font:** Geist (with ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Mono Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo, Consolas)

**Character:** Vercel's own faces, set tight and quiet. The owner chose them on purpose, and accepted the detector's overused-font warning for that reason. Weights used: 400, 500, 600. Nothing heavier.

### Hierarchy

| Role | Size | Weight | Line height | Tracking | Use |
| --- | --- | --- | --- | --- | --- |
| Display | 60px (72px on the social card) | 600 | 1.04 | -0.038em | The promise, two lines, centered. |
| Lockup | 19px (20px in the engine head, 34px on the social card) | 600 | | -0.02em | Mark plus name. |
| Lead | 19px | 400 | 1.5 | -0.006em | One line under the headline, in `fg-2`. |
| Title | 17px | 500 (600 for column headings) | | -0.012em | Diagram items, modules, gate title, column heads. |
| Body | 15px | 400 | | -0.006em | Results in `fg`, descriptions in `fg-2`. |
| Label | 14px | 400 | | | Pills, chips, footers, status lines. |
| Code | 14.5px | 400 | | 0 | Tool names only, in `fg-code`. |

The step prompt sits between title and body at 15.5px, weight 500.

### Named Rules

**The 14px Floor Rule.** No text below 14px on a 1280px canvas. README images are shown at about 70 percent, so 14px lands near 10px on screen. That is the smallest size that stays readable.

**The Real Names Rule.** Geist Mono is only for real tool names and code (`find_leads`, `launch_campaign`). Never use it for labels, numbers or decoration.

## Layout

- Canvas width is always 1280px. Heights: banner 720, diagram 624, social card 640. Wordmark is 480 x 120 on a transparent page.
- Output is 2x PNG, except the social card, which is 1x to stay under GitHub's 1 MB limit.
- Keep 48px from the canvas edge to any content.
- Hero pages stack centrally: lockup top left (or centered on the social card), centered headline, lead line, then one panel 880 to 920px wide below.
- The diagram is a five-column grid: drivers (244px), gap, engine (460px), gap, plug-ins (268px). The engine spans the full height.
- Rows inside panels have fixed heights (44px steps, 48 to 56px heads) and 20px side padding.
- Small gaps come from one set: 6, 8, 10 and 14px.

## Elevation & Depth

Depth comes from light, not from stacking. Dark uses one light source; light uses soft offset shadows.

### Shadow Vocabulary

| Name | Value | Use |
| --- | --- | --- |
| Panel, dark | `0 24px 48px -20px rgb(0 0 0 / 0.55)` | Under the one main panel. |
| Panel, light | `0 1px 2px rgb(0 0 0 / 0.04), 0 8px 16px -8px rgb(0 0 0 / 0.08), 0 32px 64px -24px rgb(0 0 0 / 0.16)` | Under the one main panel. This shadow is what separates a white panel from a white page. |
| Chip | `0 1px 2px rgb(0 0 0 / 0.06)` | Filled gate chips. |

### Light in dark

- **Room light:** one radial gradient of `room-light` behind the content, centered horizontally and placed above the panel. It fades to transparent by 72 percent of its radius, well inside the frame.
- **Edge light:** a 1px line on the panel's top edge, fading out at both ends (inset 14 to 16 percent from each side).
- **Panel grade:** the panel fill runs from `panel-top` to `panel` over its first 140px.

### Named Rules

**The One Light Rule.** One light source per dark image, from above, fully inside the frame. No second glow, no colored light.

**The Offset Shadow Rule.** Shadows always have a y offset and a blur. No flat outlines pretending to be shadows, no glows.

## Shapes

- Panels: 16px corners, 1px `line` border.
- Inset rows inside a panel (the approval row): 12px corners, 1px `line` border, `sunk` fill.
- Buttons: 8px corners.
- Pills and chips: fully round.
- Status icons: 16px circles (18px on the social card).
- Diagram wires turn with 10px rounded corners.

### The mark

A ring and the dot that has left it. The geometry is fixed and lives in `assets/README.md`: a 64 x 64 grid, ring at (27.5, 36.5) with radius 17 and stroke 8, dot at (50.5, 13.5) with radius 7. In the images it is drawn inline in `currentColor`, so it always matches the ink. One flat color, never rotated, no effects. The app icon puts it on a `#0a0a0b` tile with 28px corners on a 128px square.

## Components

### Panel
The one bright object on each image. 16px corners, graded fill, `line` border, edge light on top in dark, panel shadow. Head row with a hairline under it: name on the left, status on the right.

### Status icons
- **Done:** `green-soft` disc with a `green` 1.5px ring and a check mark.
- **Waiting:** `amber-soft` disc with a solid `amber` center dot.
- **Live dot:** a 6px `green` dot before "Connected over MCP" or "Runs 24/7" (7px on the social card).

### Step list
Grid of icon, tool name in Geist Mono, then the result in Geist. A 1px `line-strong` thread links the finished steps. The last step is the approval row: sunk, inset, with a two-line ask ("Waiting for your approval" / "Nothing is sent until you approve.") and two buttons.

### Buttons
- **Primary:** `fg` fill with `bg` text (light on dark, dark on light), 8px corners, weight 500.
- **Secondary:** transparent with a 1px `line-strong` border, `fg` text.
- Only one primary per image. It is always the human's approval.

### Pills and chips
- **Door pill:** outlined. `line-strong` border, `bg` fill so wires stop cleanly behind it, 14px label.
- **Check chip:** filled. `chip` fill, no border, chip shadow, 14px label.
- **Tag:** a small outlined pill in `fg-2` beside a workspace name ("Sandbox").

### Diagram wires
Drawn by script from the laid-out boxes, so a copy change never leaves a wire pointing at nothing.
- **Door wire:** solid, 1.5px, `wire` color, 3px dot at the source.
- **Plug-in wire:** dotted (2px round caps, dash `0.1 4.5`), `wire` color, 3px dot at each plug-in.
- **Ports:** 4.5px open circles where wires meet the engine, filled with `bg`, ringed with `wire`.

### Named Rules

**The Wire Grammar Rule.** Solid wires are doors, the ways in. Dotted wires are optional plug-ins. Outlined pills name doors; filled chips name gate checks. Never swap them.

## Do's and Don'ts

### Do:
- **Do** use only the tokens in `tokens.css`, and ship every README image in dark and light.
- **Do** render dark README images with `bg=github` so they have no edge on GitHub's dark page (`#0d1117`).
- **Do** keep text at 14px or larger on the 1280px canvas.
- **Do** keep green for done or live and amber for waiting on a person.
- **Do** use Geist Mono only for real tool names and code.
- **Do** use solid wires and outlined pills for doors, dotted wires for plug-ins, filled chips for gate checks.
- **Do** make the main panel the brightest object, with one light source above it in dark.
- **Do** keep every string true to the product, with invented names and `example.com` domains for demo data.

### Don't:
- **Don't** add an accent hue, a brand gradient or colored light.
- **Don't** use gradient text. Gradients exist only as light: the room light, the edge light and the panel grade.
- **Don't** use glass or backdrop blur.
- **Don't** use eyebrow labels (small caps or tracked uppercase above a heading). Headings are plain sentence case.
- **Don't** let any glow or shadow touch the image border.
- **Don't** use a shadow without offset and blur, or any glow.
- **Don't** redraw, rotate, outline or color the mark.
- **Don't** use the em dash character anywhere.
