import { initializeDatabase } from "./db.js";
import { createLibrary } from "./library.js";
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
  const library = createLibrary({
    onOpen: async (pdf) => {
      libraryView.hidden = true;
      history.pushState({ reader: true }, "");
      await viewer.open(pdf.id);
    }
  });
  const viewer = createViewer({
    onBack: async () => {
      libraryView.hidden = false;
      if (history.state && history.state.reader) {
        history.replaceState({}, "");
      }
      await library.refresh();
    }
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
    if (!document.querySelector("#readerView").hidden) {
      document.querySelector("#backButton").click();
    }
  });
}

start();
