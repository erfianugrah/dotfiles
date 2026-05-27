---
name: favicons-and-icons
description: Generate favicons, app icons, and brand marks via two paths — SVG (agent writes vector source for clean geometric marks / monograms) or raster (ComfyUI generates 512×512+ for rich stylised icons with gradients and materials). Either path feeds into `build_favicon_set` which produces the full PWA artifact set (favicon.ico multi-res + apple-touch + 192/512/maskable + site.webmanifest + HTML <head> snippet). Use when the user wants a favicon, app icon, brand mark, or PWA icon set.
---

# Favicons / icons / brand marks

Two paths, one converger. Decision based on visual style needed.

## Path A — SVG (vector-first)

**When:** clean geometry, small detail count, monograms, scalable marks, anything that should look crisp at 16×16.

**Process:**

1. **You write the SVG inline.** Don't shell out to generators. Models are good at SVG — paths, viewboxes, transforms, gradients, basic shapes. Iterate inline.
2. Call `build_favicon_set(svg="<full SVG>", outDir="public/", manifestName="...", themeColor="#...")`.
3. Paste the returned HTML snippet into your `<head>`.

**SVG checklist:**
- ViewBox 0 0 64 64 (or 100 100). Keep it small + scale up — easier math.
- Avoid filters / `<feGaussianBlur>` etc. — they don't always rasterize predictably at 16px.
- Use solid fills or simple linear gradients. Skip radial gradients for tiny sizes.
- Test mentally at 16×16: would two or three features still be distinguishable?
- Don't embed PNG inside SVG (defeats the point).
- Include `xmlns="http://www.w3.org/2000/svg"` — required for standalone files.

**Example — minimalist hexagon with offset H:**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <polygon points="32,4 56,18 56,46 32,60 8,46 8,18"
           fill="#0f172a" stroke="#06b6d4" stroke-width="2"/>
  <text x="32" y="42" font-family="ui-sans-serif" font-size="28"
        font-weight="700" fill="#06b6d4" text-anchor="middle">H</text>
</svg>
```

This rasterizes cleanly at every favicon size because there's exactly 3 features (hexagon edge, hexagon fill, letter).

## Path B — raster (ComfyUI)

**When:** app icon needing gradients, materials, depth shadows, illustrative content, or anything more visually rich than vector can easily express.

**Process:**

1. **Generate via ComfyUI** with an icon-tuned workflow. Defaults to know:
   - Square aspect (1024×1024 source, downscale better than upscale)
   - Transparent background (set the workflow's `EmptyLatentImage` aspect and use a transparent-bg model or rembg post-process)
   - Lower CFG (4-5) for cleaner shapes
   - ~15-20 steps (icons don't need 30+ — diminishing returns)
   - Prompt for "app icon, [subject], centered, solid color background, flat material design" or similar
2. Output to `~/docker-volumes/comfyui/output/<filename>.png` (default ComfyUI output dir).
3. Call `build_favicon_set(pngPath="/path/to/master.png", outDir="public/", ...)`.

**See the `comfyui` skill** for full ComfyUI workflow details. For icons specifically:

```bash
# Modify the SDXL default workflow:
# - "5" EmptyLatentImage: width 1024, height 1024
# - "3" KSampler: steps 18, cfg 4.5
# - "6" prompt: "app icon, <subject>, centered, flat design, vibrant colors, transparent background"
```

If background isn't transparent in output, run rembg or feather mask in the same workflow — or use `magick input.png -fuzz 5% -transparent white output.png` for solid-white backgrounds.

## Path convergence — `build_favicon_set`

Both paths end in:

```
build_favicon_set({
  svg: "..." OR pngPath: "...",
  outDir: "public",
  name: "favicon",                   // file prefix, default "favicon"
  manifestName: "Bonkled",           // PWA app name
  manifestShortName: "Bonkled",      // ≤12 chars recommended
  themeColor: "#0f172a",             // PWA <meta name=theme-color>
  backgroundColor: "#ffffff",        // PWA splash background
})
```

Outputs to `outDir`:

| File | Purpose |
|---|---|
| `favicon.ico` | Multi-res 16/32/48 — legacy + still required by some browsers |
| `favicon.svg` | Modern browsers prefer SVG (sharp at any size) — only if SVG input |
| `favicon-16.png` / `favicon-32.png` | `<link rel="icon">` PNG fallbacks |
| `apple-touch-icon.png` | 180×180, iOS home screen |
| `icon-192.png` / `icon-512.png` | PWA manifest, standard purpose |
| `icon-maskable.png` | 512×512 with 80% safe-zone — adaptive icons (Android home) |
| `site.webmanifest` | PWA manifest stub — edit it for full app metadata |

Plus the HTML snippet returned in the tool output — paste into `<head>`.

## Quick reference — when to pick which path

| Description user gives | Path |
|---|---|
| "minimalist", "monogram", "geometric", "lettermark", "logo for [tech thing]" | **SVG** |
| "make my favicon a hexagon with…", "blue square with H inside" | **SVG** |
| "app icon like [photo-realistic thing]", "with gradients and shadows" | **Raster (ComfyUI)** |
| "the kind of icon you see on iOS app store" | **Raster (ComfyUI)** |
| "just a favicon, doesn't matter exactly what" | **SVG** (faster, cleaner at tiny sizes) |
| "redo the favicon, the current one sucks" | Check what they have first — if vector-friendly, **SVG**; if rich, **Raster** |

## Anti-patterns

- **Don't write SVG, save it, then call build_favicon_set with pngPath.** Pass the SVG string directly — the tool rasterizes internally and keeps the vector original as `favicon.svg` too.
- **Don't generate a 64×64 PNG with ComfyUI.** Generate at 1024×1024, downscale. SDXL/Flux produce garbage at tiny resolutions.
- **Don't skip the manifest.** Mobile browsers and PWAs need `site.webmanifest` for proper home-screen behaviour. The tool generates a stub — fill in additional fields (description, start_url, scope) as needed.
- **Don't hand-roll the HTML snippet.** Use what the tool returns — it has all six required `<link>` tags in the right order.

## Edge cases

- **Dark/light mode favicons.** Browsers don't fully support media-query SVG favicons yet. Best practice: design a mark that works on both — solid shape with high-contrast accent, not a thin line on a light bg.
- **Animated favicons.** Not supported by this tool. If you really need them, write an APNG manually or use a third-party service.
- **Branded raster favicon with text.** Almost always looks bad at 16×16. Prefer a mark + omit text at small sizes (mainline favicon is the mark only; full logo elsewhere).
