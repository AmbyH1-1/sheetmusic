# Sheet Music Reader

A personal, offline-first sheet music PWA for iPad Safari. PDF files and annotations stay in this browser's IndexedDB; the original PDFs are never modified.

## 1. Add PDF.js

1. Download the PDF.js **prebuilt** release from Mozilla's PDF.js project.
2. Copy the ESM build and worker into `pdfjs/` with these exact names:
   - `pdfjs/pdf.mjs`
   - `pdfjs/pdf.worker.mjs`
3. Keep the two files in the repository. The app uses local relative paths and does not load a CDN.

## 2. Generate the PNG icons

The source artwork is `icons/icon.svg`. Export PNGs locally before deploying:

1. Open `icons/icon.svg` in Inkscape (free) or another SVG editor.
2. Export the page/artboard as PNG at these sizes and exact paths:
   - 180 × 180 → `icons/icon-180.png` (Apple touch icon)
   - 192 × 192 → `icons/icon-192.png`
   - 512 × 512 → `icons/icon-512.png`
3. Export a separate 512 × 512 `icons/icon-512-maskable.png` with the note centered inside the maskable safe area. Keep important artwork within the central 80% of the image.

The HTML and manifest reference these filenames. The service worker treats the PNGs as optional until generated, so their absence does not prevent its installation; add them before publishing for complete Home Screen icons.

## 3. Deploy with GitHub Pages

1. Create a GitHub repository and add the app files, the PDF.js files, and generated icons.
2. In the repository, open **Settings → Pages** and publish from the desired branch and folder.
3. Open the repository's Pages URL, including its repository subpath, for example `https://USER.github.io/REPO/`. App, worker, manifest, and asset paths are relative so the subpath is supported.
4. On iPad, open that URL in Safari. Use **Share → Add to Home Screen**, then launch the app from its Home Screen icon.

## 4. Update the app

For every deployment, increment the application version in the `application-version` meta tag in `index.html` and set `CACHE_NAME` in `sw.js` to the same version (for example `sheetmusic-2.2.0`). The Library screen displays the application version. The worker removes older `sheetmusic-` caches and activates the new one automatically.

## 5. Back up and restore

- Tap **Export backup** and use the iPad share sheet to save the JSON file to Files or send it with AirDrop. The backup contains PDF data, page annotations (including opacity), settings, a format version, and export date.
- Tap **Import backup**, choose the JSON file, then choose **Merge** or **Replace all**. Merge preserves existing items and adds records that are not already present. Replace all requires confirmation and replaces PDFs, annotations, and settings.
- Back up regularly. Persistent storage reduces eviction risk but does not replace a backup.

## 6. Quick recording

- In the Reader, expand **Quick recording**, tap **Record**, and allow microphone access when prompted. Recordings are temporary, kept in memory only, limited to five minutes, and are not included in backups. They are discarded when the app closes.
- Use **Re-record** to replace the current clip, **Play** to listen, or **Discard** to remove it. The app releases microphone access when recording stops.
- **Metronome during recording** is on by default. Headphones keep the metronome clicks out of the recording. Playback pauses a running metronome and resumes it afterward.

## 7. Reader controls

- The page number opens page navigation. The toolbar, annotation tools, metronome, recorder, and page navigation can each be minimized.
- Choose **Single**, **Two pages**, or **Auto** in the reader toolbar. Auto uses a spread in landscape and a single page in portrait. In Two pages mode, **Cover alone** shows page 1 by itself on the right; page navigation and annotations continue to use the original PDF page numbers.
- Choose **Best fit**, **Fit width**, or **Fit height** from **Page fit**. Best fit is the default and keeps the full page or spread visible; Fit width scrolls tall pages vertically. Fit height uses the available height when the full page or spread fits the width, and scales down otherwise to prevent horizontal clipping. **Trim margins** crops only the display, leaving PDFs and normalized annotation coordinates unchanged. Adjust its padding or use **Reset trim** to rescan a PDF.
- Use **Focus** to hide the reader controls while keeping page navigation and a running metronome available. Tap **Show controls** to restore them.
- Expanded trays minimize after eight seconds of inactivity by default. Turn this off in **Reader preferences** in the Library.
- To inspect layout overflow and ink input during development, open the app with `?debug=1`; the screen shows the UI overflow count and ink mode, tool, canvas sizes, pointer-event counters, and visible-page stroke counts.

## Troubleshooting

- **A stale app is still shown:** close and reopen the Home Screen app. Confirm that the visible build version and `CACHE_NAME` were both bumped on deploy. If needed, visit the Pages URL online once so the new worker can install.
- **Storage was cleared:** restore the most recent JSON backup. Without a backup, deleted browser storage cannot be recovered.
- **Metronome is muted:** tap Start from within the app, check the volume control and iPad silent/audio settings, and allow Safari to play audio.
- **Recording cannot access the microphone:** allow microphone access for Safari or the Home Screen app in iPad Settings. Close any other app currently using the microphone.
- **A PDF will not open:** verify it is a valid PDF, re-import it from Files, and confirm both PDF.js files are present at the exact paths listed above.
- **Offline launch fails:** open the Pages URL online once and wait for the service worker to install. Check that the PDF.js files and app shell files were uploaded successfully.
