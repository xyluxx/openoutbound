# OpenOutbound brand assets

The images are rendered from the HTML pages in [`src/`](src/) with a local Chrome, so every PNG is sharp on high-density screens and needs no web fonts on GitHub. The mark is hand-written SVG. The design system behind them is in [DESIGN.md](DESIGN.md); the product context is in [PRODUCT.md](PRODUCT.md).

## Files

| File | Size | Use it for |
| --- | --- | --- |
| `banner-dark.png`, `banner-light.png` | 2560 x 1440 (1280 x 720 at 2x) | README hero: name, promise, and one agent session that stops for your approval. |
| `how-it-works-dark.png`, `how-it-works-light.png` | 2560 x 1248 (1280 x 624 at 2x) | Architecture: who drives the engine, the safety gate, the modules, the optional plug-ins. |
| `social-preview.png` | 1280 x 640 | GitHub social preview card. |
| `logo-dark.svg`, `logo-light.svg` | 64 x 64 | The mark for dark and for light backgrounds. |
| `icon.svg` | 128 x 128 | The mark on its dark tile, for avatars and app icons. |
| `wordmark-dark.png`, `wordmark-light.png` | 960 x 240, transparent | Mark plus name for dark and for light backgrounds. Show them at 40 to 60 px tall. |
| `src/` | | `tokens.css` and one HTML page per image. |

## Using them in a README

GitHub switches `<picture>` sources with the viewer's theme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img alt="OpenOutbound, the AI SDR engine any agent can drive." src="assets/banner-light.png" width="100%">
</picture>
```

The same pattern works for the diagram, the wordmark and the mark.

## Rendering

Change the HTML in `src/`, then render every image, or only some:

```sh
node scripts/render-brand.mjs
node scripts/render-brand.mjs banner how-it-works
```

The script looks for Chrome, Chromium or Edge in the usual places; set `CHROME_PATH` to use another binary. The pages load Geist and Geist Mono from Google Fonts, so rendering needs network access. Each page takes `?theme=dark` or `?theme=light`, so you can also open it in a browser to check a change before rendering.

## Social preview

GitHub reads the card from Settings > General > Social preview, so upload `social-preview.png` there by hand after it changes. It is rendered at 1x to stay well under the 1 MB limit.

## The mark

A ring, and the dot that has left it: outbound, in two shapes.

- Grid: 64 x 64. Ring centered at `(27.5, 36.5)`, radius 17, stroke 8. Dot centered at `(50.5, 13.5)`, radius 7.
- Clear space: at least the dot's diameter on every side.
- Smallest size: 16 px for the mark, 20 px tall for the wordmark.
- One flat color: `#EDEDEF` on dark, `#1D1D1F` on light. No gradients, outlines, shadows or glows, and never rotated.
