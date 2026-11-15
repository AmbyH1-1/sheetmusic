# Performance measurements

Measurements were captured with `?perf=1`. The in-app readout is disabled unless that query parameter is present.

## Baseline (before optimizations)

Environment: VS Code integrated Chromium 150 on Windows, 731 × 403 CSS pixels, device pixel ratio 1.5. This is not an iPad measurement. The test library contained a 20-page, 5,301-byte PDF and a separate 4 MiB PDF-sized buffer. Results are timing samples from this browser session, not guarantees for Safari.

| Area | Before |
| --- | --- |
| Navigation start to interactive | 37.4 ms |
| App module resource transfer sum | 17.0 ms across 10 modules |
| IndexedDB initialization | 3.0 ms |
| Library read (2 PDFs, including 4 MiB buffer) | 7.5 ms |
| Library DOM render | 0.1 ms |
| Service worker registration | 0.5 ms |
| PDF IndexedDB read (5.3 KiB document) | 17.2 ms |
| PDF.js module import | 22.3 ms |
| PDF buffer copy | <0.1 ms |
| PDF.js `getDocument()` | 52.6 ms |
| First `getPage()` / PDF render / annotations visible | 0.4 / 6.5 / 8.6 ms |
| Total PDF open | 102.2 ms |
| Cached page turn | 1.6 ms |
| Uncached page turns | 2.9–6.3 ms |
| Thumbnail generation | 3.5–4.2 ms per visible page |
| Peak thumbnail test: canvases / cached pages / loaded page objects | 22 / 4 / 14 |
| Peak thumbnail cache / page-render cache estimate | 0.89 MiB / 3.05 MiB |
| Ink pointer-to-draw, pen (121 samples) | 0.04 ms average, 0.20 ms max |
| Ink pointer-to-draw, highlighter (501 samples) | 0.16 ms average, 0.60 ms max |
| Ink frame interval while drawing | 4.19 ms average, 12.5 ms max |
| Annotation autosave (two one-stroke saves) | 0.6 ms and 0.9 ms |
| Metronome over observed one-minute windows | 0 ms average/max scheduling lateness; scheduler jitter 0.51–2.12 ms average, 14.9 ms max |
| JavaScript heap (when available) | 9.5–11.6 MiB during reader tests |

The metronome values are AudioContext scheduling measurements from the instrumented Chromium session. The ink and rendering figures use a synthetic PDF and mouse-generated strokes; they do not represent Pencil latency on an iPad.

## Optimizations and after measurements

After measurements were taken in the same VS Code integrated Chromium 150 session, at 1,024 × 768 CSS pixels and DPR 1.5. The viewport differs from the baseline (731 × 403), so timing comparisons are indicative rather than a controlled benchmark. The PDF fixture and 4 MiB library-buffer fixture were unchanged.

| Area | After |
| --- | --- |
| Navigation start to interactive | 90.4 ms |
| App module resource transfer sum | 24.7 ms across 10 modules |
| IndexedDB initialization | 4.9 ms |
| Library read (2 PDFs, including 4 MiB buffer) | 0.3 ms |
| Library DOM render | 5.8 ms |
| Service worker registration | 0.6 ms |
| PDF IndexedDB read (5.3 KiB document) | 21.3 ms |
| PDF.js module import | 27.8 ms |
| PDF buffer copy | <0.1 ms |
| PDF.js `getDocument()` | 51.6 ms |
| First `getPage()` / PDF render / annotations visible | 0.5 / 6.3 / 8.8 ms |
| Total PDF open | 110.8 ms |
| Cached page turn, visible with annotations | 1.2 ms |
| Uncached page turn, visible with annotations | 5.9 ms |
| Thumbnail generation | 1.8–3.0 ms per page (four visible-page samples) |
| Peak thumbnail test: canvases / cached pages / loaded page objects | 14 / 3 / 3 (12 thumbnails rendered) |
| Peak thumbnail cache / page-render cache estimate | 0.89 MiB / 3.05 MiB (12-entry / 3-page limits) |
| Ink pointer-to-draw, pen (121 samples) | 0.03 ms average, 0.20 ms max |
| Ink pointer-to-draw, highlighter (500 samples) | 0.04 ms average, 0.50 ms max |
| Ink frame interval while drawing (448 samples) | 4.17 ms average, 4.40 ms max |
| Annotation autosave (one save, two stored strokes) | 0.8 ms |
| Metronome over one-minute window | 0 ms average/max scheduling lateness; scheduler jitter 0.56 ms average, 4.60 ms max (96 clicks, 2,400 scheduler ticks) |
| JavaScript heap (when available) | 5.6–6.7 MiB during reader tests |

The open-time sample did not improve: its IndexedDB read was slower than baseline, while PDF.js parsing stayed near 52 ms. The metadata-only library read dropped from 7.5 ms to 0.3 ms with the same 4 MiB library fixture. A 20-cycle open/close check returned to two live reader canvases each time. Thumbnail work stopped after the navigation panel closed; no additional thumbnails were generated during the following 800 ms observation.

These are browser measurements, not iPad Safari measurements. The app still needs the iPad checklist below, particularly for PDF parsing, Pencil input, audio routing, and battery use.

## Changes motivated by measurements or known hot paths

- The library list previously used `getAll()` on PDF records, cloning each complete ArrayBuffer although cards only need metadata. Page-position updates also read and rewrote the complete PDF record. The metadata store keeps these operations small while preserving the original PDF record and backup format.
- The reader created thumbnail canvases for every page, retained page proxies as thumbnails were visited, and the background pre-render could exceed the nominal three-page cache. Thumbnail canvases and page proxies are now bounded/lazy, background work is idle-scheduled and cancellable, and cached canvases are explicitly released.
- PDF render resolution is capped at two device pixels per CSS pixel to bound raster memory on high-DPI displays.
- The ink hot path queried canvas layout repeatedly for each sampled point/segment. Canvas bounds are now measured once per stroke, and redraws reuse one measured size. Broader incremental/rAF ink changes were deliberately not made: the measured 500-sample highlighter stroke was below 1 ms average on this browser, and changing its compositing path without an iPad Pencil measurement risked visible highlighter differences.
- Audio click scheduling was left unchanged; it already uses the AudioContext clock. Debug mode now records scheduler lateness and timer jitter without changing click timing.
- PDF opening was deliberately not rewritten: `getDocument()` remained the dominant step and did not measurably improve in this sample. The buffer remains an `ArrayBuffer` in IndexedDB and receives one fresh copy for each PDF.js open.

## iPad comparison checklist

Use the same PDF and the same orientation before and after deployment:

1. Open a 100+ page score and compare startup, PDF storage read, `getDocument()`, first render, and total open in `?perf=1`.
2. Turn pages repeatedly in both directions. Compare cached and uncached page-turn readings and verify page 1/current/next cache count never exceeds 3.
3. Open page navigation, scroll the thumbnail grid, then close and reopen it. Check that only visible thumbnails render, the cache remains at most 12 entries, and pending work stops while closed.
4. Draw long pen and highlighter strokes with Apple Pencil at normal speed and fast scribbling. Compare pointer-to-draw and frame intervals; verify stroke appearance, undo/redo, and saved annotations.
5. Run the metronome for at least one minute in the foreground. Compare scheduling lateness and jitter; confirm audio continues to sound even when panels are minimized.
6. Open and close a PDF 20 times, checking that reader canvases, cached pages, thumbnails, and memory return to their prior levels.
7. Repeat in portrait and landscape, in Safari and the Home Screen app. Compare the on-screen readout rather than expecting the Chromium numbers above to match iPad values.
