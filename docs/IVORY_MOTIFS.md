# Study Clinic: ivory motif refinement

2026-09-09. Continued from the current working tree at `cd27c51`. The existing uncommitted brand, icon and view edits were preserved and excluded from this background commit.

## Direction and placement

The selected logo's open crescent, changing curve weight and ascending path suggest **tapered trajectories**: a few large, incomplete curves in exceptionally pale sage ink. They introduce recognizable shape to the ivory environment without repeating the logo, its star or its nodes. This adds a motif to the material base described in `PAPER_BACKGROUNDS.md`; it does not replace the existing paper with another texture treatment.

Live inspection preceded generation. Home and materials have substantial open ivory space; progress and the course library have useful margins between opaque surfaces. The course structure's expanded content is already protected by opaque paper. Lessons, settings and the knowledge map carry dense reading, controls or meaningful diagram geometry and receive no motif.

| Surface | Treatment | Desktop / mobile result |
| --- | --- | --- |
| Course library | Motif in the environment around existing books and course cards | Clear hierarchy; artwork unchanged |
| Course home | Quiet arcs at the right and lower perimeter | Visible on closer inspection; green next action unchanged |
| Materials | Most visible in the large unused ivory area | Cards and text remain clean |
| Progress | Curves in surrounding space | Summary surfaces and status colors unchanged |
| Curriculum | Environmental motif outside opaque reading panels | Structure and content remain dominant |
| Study | Original paper, no motif | Long reading surface unchanged |
| Knowledge map | Original paper and canvas, no motif | Decorative curves cannot be mistaken for relationships |
| Settings | Original paper, no motif | Forms and supporting text unchanged |

## Generation and selection

Used the existing, unmodified `C:/Users/smallfish/.codex/tools/imagegen-endpoint.ps1`, which invokes the imagegen skill CLI through its verified endpoint adapter and loads the authorized configuration from `C:/Users/smallfish/open-source/hy3-study-clinic-v2-workspace/.env`. No credentials were copied into project files or logs. This was the explicitly requested CLI/API workflow.

Generated three independent studies, each supplied with the selected logo board, the user's product screenshot and this run's actual materials-page screenshot. The outputs were converted into temporary pale motif layers and compared inside the running product on home and materials at 1440 × 1000 and 390 × 844.

| Study | Finding in the product | Decision |
| --- | --- | --- |
| Open arcs with waypoints | The dots read like diagram nodes or status markers, especially on mobile | Reject |
| Tapered trajectories | Echoes the logo's movement and the existing green artwork; clear open reading field | Select |
| Page-contour echoes | Too many crossing lines; the portrait crop becomes more decorative | Reject |

A fourth generation refined the selected image into slimmer, separated crescents. That edit received the selected study, logo board, real home capture with the study applied, and the original product screenshot. The final source returned at 3456 × 2304 and was reduced to 1920 × 1280.

Raw studies and refinement: `hy3-study-clinic-v2-workspace/output/imagegen/ivory-motifs/`.

Full prompts, conversion scripts and check logs: `hy3-study-clinic-v2-workspace/working/ivory-motifs/`. Prompt files are `open-arcs.txt`, `tapered-paths.txt`, `page-echoes.txt` and `refined-trajectories.txt` in its `prompts/` directory.

## Integration

`apps/web/public/backgrounds/understanding-arcs.webp` is a **24,548-byte**, 1920 × 1280 lossless WebP with alpha. It contains the actual generated motif, with the generated ivory field removed. Approximately 95.9% of its pixels are fully transparent. It does not contain new grain, lettering or logo artwork.

The conversion resizes the source with Lanczos, smooths only subpixel noise with a 0.45px Gaussian blur, and measures the blank upper-left field's median luminance. Alpha is `clamp(round((blank - luminance - 4) * 9), 0, 160)`, with pale ink RGB `(239, 240, 230)`. This normalization retains the generated shapes. The ink color itself has 4.558:1 contrast against the existing muted text color, avoiding the darkened paper edges produced by a dark translucent watermark.

Source image SHA-256: `ad07c88864bf4142986e8b06952650d002532dc14a3fefb439648712f4d9e658`.

Production WebP SHA-256: `f7126b6184088a044741eb05299c04110ab4795f8ba6a93e7412a7546125ca3c`. The built asset matches the source asset byte for byte.

`apps/web/src/studio.css` adds one background layer and an explicit allowlist of shell destinations. `--paper-motif` defaults to `none`. The same asset is reused with `cover`, `right center` and `no-repeat`, behind the existing internal scroll container. Portrait crops retain the right-hand curves; document length does not stretch or tile the motif. The existing paper light, microscopic fiber layer, opaque content surfaces and ivory fallback remain intact.

No DOM, component, layout, routing, behavior, logo, green-surface or text-color changes are included. Existing print, forced-color and increased-contrast rules disable the decorative background.

## Verification

Production preview: `http://127.0.0.1:5511`, serving the current repository build with existing local course data. Browser validation used headed Chromium.

- All eight surfaces above inspected at 1440 × 1000 and 390 × 844. No horizontal overflow or JavaScript errors during the normal page checks. Exact layout rectangles were unchanged when the motif was disabled.
- Paired captures confirm unchanged green navigation, green next-action interiors and material-card reading interiors. Study, map and settings match across their entire views. Pixel comparison permits only one channel value of Chromium gradient dithering between frames.
- Additional 320px, 768px and 1920px checks on home, materials, curriculum and study: 12 combinations, no overflow.
- Separate mobile context at 390 × 844, DPR 2 and touch enabled: home and materials captured; navigation drawer opened and materials selected by touch.
- Scrolled home: background scale unchanged. Mobile map fit control checked. Missing motif request: existing paper and solid ivory fallback remain usable. Forced colors, increased contrast and print: background images disabled.
- Actual rendered background captures, including paper, fiber and motif, retain at least **4.52:1** for the existing muted text and **4.56:1** for faint text across desktop, wide desktop and mobile samples. This is a scoped background-color check, not an application-wide accessibility claim.
- `npm run build` passed; final asset followed by `npm run build -w @hy3-clinic/web`. Existing large-JavaScript-chunk warning remains.
- `npm run test -w @hy3-clinic/web`: **31 files, 468 tests passed**.
- `npm run lint` and `git diff --check` passed. Existing three Hooks warnings remain. Generated browser YAML was formatted separately; existing user edits were not formatted or staged.

Screenshots and comparisons are saved under `output/playwright/ivory-motifs/` (local, ignored): `motif-studies-comparison.jpg`, `final-before-after.jpg`, individual `final-*-desktop.png` / `final-*-mobile.png`, DPR 2 touch captures and fallback captures.

## Final refinement prompt

```text
Use case: style-transfer.
Asset type: final warm-ivory background motif for Study Clinic; 1536 x 1024 landscape.
Input images: image 1 is the selected tapered-paths background study, the edit target. Image 2 is the selected brand logo board, reference for open, slender crescents and the tapering ascending trajectory, not for copying the logo. Image 3 is the live home screenshot with the study in use, a context reference only, never reproduce UI. Image 4 is the user's product screenshot, a palette and restraint reference only.
Refinement request: keep image 1's ivory palette, extraordinarily low contrast, asymmetrical lower-right to upper-right motion, and large open reading field. Refine only the weight and rhythm of the motif. Make the two broad tapering curved shapes about 60 percent slimmer, more like long elegant open crescent traces than broad graphic ribbons. Keep a gently varied radius of curvature, not mechanically concentric. Separate them with generous ivory space. Preserve one smaller detached curve in the upper-right, but let its ends taper softly away so it never looks like a hard cropped fragment. The resulting two long crescents and one quiet partial echo must have discernible contours and faint flat filled interiors: a true visible motif when examined, not merely a grain or light effect. Preserve the source composition's blank left 65 percent. Most geometry stays in the outer right third and lower quarter; no line through the upper-left content area. Large non-repeating scale; elegant when cropping to the rightmost quarter in portrait.
Keep the backdrop smooth warm ivory around #f8f7f0, shapes extremely pale grey-sage and warm limestone. No contrast increase. No cast shadows, embossed edges, sculptural paper, texture, dramatic light or photorealistic objects. No letters, text, UI, logo, closed emblem, stars, circles, waypoint dots, botanical forms, grid, border, tiling, wallpaper, parallel stripe bundle, dense topography or decorative illustration. Return only the standalone background image.
```
