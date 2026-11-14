import { initializeDatabase } from "./db.js";
import { createAnnotator } from "./annotate.js";
import { createLibrary } from "./library.js";
import { createMetronome } from "./metronome.js";
import { createViewer } from "./viewer.js";

const libraryView = document.querySelector("#libraryView");
const libraryMessage = document.querySelector("#libraryMessage");

function showLibraryMessage(text) {
  libraryMessage.textContent = text;
}

function preventGestureZoom() {
  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
}

async function start() {
  preventGestureZoom();
  const metronome = createMetronome();
  let viewer;
  const annotator = createAnnotator({
    onModeChange: (active) => viewer.setAnnotationMode(active)
  });
  const library = createLibrary({
    onOpen: async (pdf) => {
      libraryView.classList.remove("is-active");
      libraryView.setAttribute("aria-hidden", "true");
      history.pushState({ reader: true }, "");
      await viewer.open(pdf.id);
    }
  });
  viewer = createViewer({
    onBack: async () => {
      await annotator.exitMode();
      metronome.stop();
      libraryView.classList.add("is-active");
      libraryView.setAttribute("aria-hidden", "false");
      if (history.state && history.state.reader) {
        history.replaceState({}, "");
      }
      await library.refresh();
    },
    isAnnotating: () => annotator.isActive(),
    onPageChange: (pdfId, pageNumber) => annotator.setPage(pdfId, pageNumber)
  });

  try {
    await initializeDatabase();
    await library.refresh();
  } catch (error) {
    showLibraryMessage(`Could not start the music library: ${error.message}`);
    return;
  }

  if (navigator.storage && typeof navigator.storage.persist === "function") {
    try {
      const persisted = await navigator.storage.persist();
      if (!persisted) {
        showLibraryMessage("Storage is available, but the browser may clear it. Exported backups will be added in a later stage.");
      }
    } catch (error) {
      showLibraryMessage(`Could not request persistent storage: ${error.message}`);
    }
  }

  window.addEventListener("popstate", () => {
    if (document.querySelector("#readerView").classList.contains("is-active")) {
      document.querySelector("#backButton").click();
    }
  });
}

start();
