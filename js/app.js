import { getSetting, initializeDatabase, setSetting } from "./db.js";
import { createAnnotator } from "./annotate.js";
import { createLibrary } from "./library.js";
import { createMetronome } from "./metronome.js";
import { createViewer } from "./viewer.js";

const libraryView = document.querySelector("#libraryView");
const libraryMessage = document.querySelector("#libraryMessage");
const offlineIndicator = document.querySelector("#offlineIndicator");
const storageStatus = document.querySelector("#storageStatus");
const requestStorageButton = document.querySelector("#requestStorageButton");
const installInstructions = document.querySelector("#installInstructions");
const updateMessage = document.querySelector("#updateMessage");
const serviceWorkerStatus = document.querySelector("#serviceWorkerStatus");

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showLibraryMessage(text) {
  libraryMessage.textContent = text;
}

function updateOfflineIndicator() {
  const online = navigator.onLine;
  offlineIndicator.dataset.online = String(online);
  offlineIndicator.hidden = online;
  offlineIndicator.textContent = "Offline — your downloaded library is available";
}

async function updateStorageStatus(requestPersistence) {
  const storage = navigator.storage;
  if (!storage) {
    storageStatus.textContent = "Storage status is not available in this browser.";
    return;
  }

  let persistenceText = "Persistent storage is not supported.";
  if (typeof storage.persist === "function" && requestPersistence) {
    requestStorageButton.disabled = true;
    try {
      const persisted = await storage.persist();
      persistenceText = persisted
        ? "Persistent storage granted."
        : "Persistent storage not granted; the browser may clear data.";
    } catch (error) {
      persistenceText = `Persistent storage request failed: ${error.message}`;
    } finally {
      requestStorageButton.disabled = false;
    }
  } else if (typeof storage.persisted === "function") {
    try {
      const persisted = await storage.persisted();
      if (requestPersistence && typeof storage.persist !== "function") {
        persistenceText = persisted
          ? "Storage is persistent; new persistence requests are not supported."
          : "Persistent storage requests are not supported; the browser may clear data.";
      } else {
        persistenceText = persisted
          ? "Persistent storage granted."
          : "Persistent storage not granted; the browser may clear data.";
      }
    } catch (error) {
      persistenceText = `Could not read persistent storage status: ${error.message}`;
    }
  } else if (requestPersistence) {
    persistenceText = "Persistent storage requests are not supported by this browser.";
  }

  let usageText = "Storage usage is not available.";
  if (typeof storage.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      usageText = `Using ${formatStorageBytes(estimate.usage)} of ${formatStorageBytes(estimate.quota)}.`;
    } catch (error) {
      usageText = `Could not estimate storage usage: ${error.message}`;
    }
  }
  storageStatus.textContent = `${persistenceText} ${usageText}`;
}

function isSafariBrowser() {
  const userAgent = navigator.userAgent;
  return /Safari/i.test(userAgent) &&
    !/(Chrome|Chromium|CriOS|Edg|FxiOS|OPR|OPiOS|DuckDuckGo)/i.test(userAgent);
}

function isRunningStandalone() {
  return navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
}

async function showInstallInstructionsIfNeeded() {
  if (!isSafariBrowser() || isRunningStandalone()) return;
  try {
    const dismissed = await getSetting("installInstructionsDismissed", false);
    installInstructions.hidden = dismissed === true;
  } catch (error) {
    installInstructions.hidden = false;
    showLibraryMessage(`Could not load install instructions setting: ${error.message}`);
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    serviceWorkerStatus.textContent = "Offline support is unavailable in this browser.";
    return;
  }

  const wasControlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (wasControlled) updateMessage.hidden = false;
  }, { once: true });
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).then((registration) => {
    serviceWorkerStatus.textContent = "Offline app shell registered.";

    function watchForUpdate(worker) {
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && wasControlled) {
          updateMessage.hidden = false;
        } else if (worker.state === "redundant") {
          serviceWorkerStatus.textContent = wasControlled
            ? "Update could not be installed; the previous offline version remains active."
            : "Offline support could not be installed. Verify that app assets are available.";
        }
      });
    }

    if (registration.installing) watchForUpdate(registration.installing);
    registration.addEventListener("updatefound", () => {
      if (registration.installing) watchForUpdate(registration.installing);
    });
    if (registration.waiting && wasControlled) {
      updateMessage.hidden = false;
    }
  }).catch((error) => {
    serviceWorkerStatus.textContent = `Offline support could not be enabled: ${error.message}`;
  });
}

function preventGestureZoom() {
  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
}

async function start() {
  preventGestureZoom();
  const version = document.querySelector('meta[name="application-version"]').content;
  document.querySelector("#buildVersion").textContent = `Build ${version}`;
  updateOfflineIndicator();
  window.addEventListener("online", updateOfflineIndicator);
  window.addEventListener("offline", updateOfflineIndicator);
  requestStorageButton.addEventListener("click", () => updateStorageStatus(true));
  document.querySelector("#reloadAppButton").addEventListener("click", () => window.location.reload());
  document.querySelector("#dismissInstallInstructions").addEventListener("click", async () => {
    try {
      await setSetting("installInstructionsDismissed", true);
      installInstructions.hidden = true;
    } catch (error) {
      showLibraryMessage(`Could not save install instruction preference: ${error.message}`);
    }
  });

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

  await Promise.all([
    updateStorageStatus(true),
    showInstallInstructionsIfNeeded()
  ]);
  registerServiceWorker();

  window.addEventListener("popstate", () => {
    if (document.querySelector("#readerView").classList.contains("is-active")) {
      document.querySelector("#backButton").click();
    }
  });
}

start();
