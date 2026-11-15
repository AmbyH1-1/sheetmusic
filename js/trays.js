import { getSetting, setSetting } from "./db.js";

const TRAY_KEYS = ["toolbar", "annotation", "metronome", "recorder", "pageJump"];
const AUTO_MINIMIZE_DELAY = 8000;
const DEFAULTS = {
  expanded: {
    toolbar: false,
    annotation: false,
    metronome: false,
    recorder: false,
    pageJump: false
  },
  focusMode: false,
  autoMinimize: true
};

export function createTrayManager({ viewer, onError = () => {} }) {
  const readerView = document.querySelector("#readerView");
  const toolbar = document.querySelector("#readerToolbar");
  const annotation = document.querySelector("#annotationToolbar");
  const metronome = document.querySelector("#metronomePanel");
  const recorder = document.querySelector("#recorderPanel");
  const pageJump = document.querySelector("#pageJumpPanel");
  const autoMinimizeInput = document.querySelector("#autoMinimizeTrays");
  const focusRestoreButton = document.querySelector("#focusRestoreButton");
  const trayElements = { toolbar, annotation, metronome, recorder, pageJump };
  const timers = new Map();
  let settings = structuredDefaults();
  let applying = false;
  let activeSlider = null;

  function structuredDefaults() {
    return {
      expanded: { ...DEFAULTS.expanded },
      focusMode: DEFAULTS.focusMode,
      autoMinimize: DEFAULTS.autoMinimize
    };
  }

  function updateToolbarControls(expanded) {
    document.querySelector("#toolbarMinimizeButton").hidden = !expanded;
    document.querySelector("#toolbarExpandButton").hidden = expanded;
  }

  function updateAnnotationControl(expanded) {
    const button = document.querySelector("#annotationTrayToggle");
    button.textContent = expanded ? "Minimize tools ⌃" : "Tools ⌄";
    button.setAttribute("aria-label", expanded ? "Minimize annotation tools" : "Expand annotation tools");
  }

  function applyExpanded(key, expanded) {
    settings.expanded[key] = expanded;
    if (key === "toolbar") {
      toolbar.classList.toggle("is-minimized", !expanded);
      updateToolbarControls(expanded);
    } else if (key === "annotation") {
      annotation.classList.toggle("is-minimized", !expanded);
      updateAnnotationControl(expanded);
    } else if (key === "metronome") {
      metronome.open = expanded;
    } else if (key === "recorder") {
      recorder.open = expanded;
    } else if (key === "pageJump" && viewer && viewer.hasDocument()) {
      viewer.setPagePanelExpanded(expanded, false);
    }
    updateDockClasses();
  }

  function applyFocusMode() {
    readerView.classList.toggle("is-focus-mode", settings.focusMode);
    focusRestoreButton.hidden = !settings.focusMode;
  }

  function updateDockClasses() {
    readerView.classList.toggle("has-expanded-annotation", settings.expanded.annotation);
    readerView.classList.toggle(
      "has-expanded-audio",
      settings.expanded.metronome || settings.expanded.recorder
    );
  }

  function saveSettings() {
    setSetting("readerTrayPreferences", settings).catch((error) => {
      onError(`Could not save reader preferences: ${error.message}`);
    });
  }

  function clearTimer(key) {
    window.clearTimeout(timers.get(key));
    timers.delete(key);
  }

  function hasActiveSlider(key) {
    const element = trayElements[key];
    return Boolean(activeSlider && element && element.contains(activeSlider));
  }

  function isRecording() {
    return recorder.classList.contains("is-recording");
  }

  function scheduleAutoMinimize(key) {
    clearTimer(key);
    if (!settings.autoMinimize || settings.focusMode || !settings.expanded[key]) return;
    timers.set(key, window.setTimeout(() => {
      if (key === "recorder" && isRecording()) return;
      if (hasActiveSlider(key)) {
        scheduleAutoMinimize(key);
        return;
      }
      setExpanded(key, false);
    }, AUTO_MINIMIZE_DELAY));
  }

  function setExpanded(key, expanded, persist = true) {
    if (!TRAY_KEYS.includes(key)) return;
    const next = Boolean(expanded);
    if (next) {
      for (const otherKey of TRAY_KEYS) {
        if (otherKey !== key && settings.expanded[otherKey]) {
          clearTimer(otherKey);
          applyExpanded(otherKey, false);
        }
      }
    }
    const changed = settings.expanded[key] !== next;
    applyExpanded(key, next);
    if (next) scheduleAutoMinimize(key);
    else clearTimer(key);
    if (changed && persist && !applying) saveSettings();
  }

  function setFocusMode(enabled) {
    const next = Boolean(enabled);
    if (settings.focusMode === next) return;
    settings.focusMode = next;
    applyFocusMode();
    if (next) {
      for (const key of TRAY_KEYS) clearTimer(key);
    } else {
      for (const key of TRAY_KEYS) scheduleAutoMinimize(key);
    }
    saveSettings();
  }

  function syncFromElement(key) {
    if (applying) return;
    let expanded;
    if (key === "toolbar") expanded = !toolbar.classList.contains("is-minimized");
    else if (key === "annotation") expanded = !annotation.classList.contains("is-minimized");
    else if (key === "metronome") expanded = metronome.open;
    else if (key === "recorder") expanded = recorder.open;
    else expanded = !pageJump.hidden;
    if (settings.expanded[key] !== expanded) setExpanded(key, expanded);
  }

  function setAutoMinimize(enabled) {
    settings.autoMinimize = Boolean(enabled);
    if (!settings.autoMinimize) {
      for (const key of TRAY_KEYS) clearTimer(key);
    } else {
      for (const key of TRAY_KEYS) scheduleAutoMinimize(key);
    }
    saveSettings();
  }

  function applyForDocument() {
    applying = true;
    for (const key of TRAY_KEYS) applyExpanded(key, settings.expanded[key]);
    updateDockClasses();
    applying = false;
    applyFocusMode();
    for (const key of TRAY_KEYS) scheduleAutoMinimize(key);
  }

  async function initialize() {
    try {
      const saved = await getSetting("readerTrayPreferences", null);
      if (saved && typeof saved === "object") {
        if (saved.expanded && typeof saved.expanded === "object") {
          for (const key of TRAY_KEYS) {
            if (typeof saved.expanded[key] === "boolean") {
              settings.expanded[key] = saved.expanded[key];
            }
          }
        }
        if (typeof saved.focusMode === "boolean") settings.focusMode = saved.focusMode;
        if (typeof saved.autoMinimize === "boolean") settings.autoMinimize = saved.autoMinimize;
      }
    } catch (error) {
      onError(`Could not load reader preferences: ${error.message}`);
    }

    const expandedKeys = TRAY_KEYS.filter((key) => settings.expanded[key]);
    if (expandedKeys.length > 1) {
      for (const key of expandedKeys.slice(0, -1)) settings.expanded[key] = false;
    }
    autoMinimizeInput.checked = settings.autoMinimize;
    applyForDocument();
  }

  document.querySelector("#toolbarMinimizeButton").addEventListener("click", () => setExpanded("toolbar", false));
  document.querySelector("#toolbarExpandButton").addEventListener("click", () => setExpanded("toolbar", true));
  document.querySelector("#annotationTrayToggle").addEventListener("click", () => {
    setExpanded("annotation", !settings.expanded.annotation);
  });
  document.querySelector("#focusModeButton").addEventListener("click", () => setFocusMode(true));
  focusRestoreButton.addEventListener("click", () => setFocusMode(false));
  autoMinimizeInput.addEventListener("change", () => setAutoMinimize(autoMinimizeInput.checked));

  for (const key of ["metronome", "recorder"]) {
    trayElements[key].addEventListener("toggle", () => syncFromElement(key));
  }
  new MutationObserver(() => {
    if (settings.expanded.recorder && !isRecording()) scheduleAutoMinimize("recorder");
  }).observe(recorder, { attributes: true, attributeFilter: ["class"] });
  for (const key of ["toolbar", "annotation"]) {
    new MutationObserver(() => syncFromElement(key))
      .observe(trayElements[key], { attributes: true, attributeFilter: ["class"] });
  }

  document.addEventListener("pointerdown", (event) => {
    const slider = event.target.closest('input[type="range"]');
    if (!slider) return;
    activeSlider = slider;
    for (const key of TRAY_KEYS) {
      if (trayElements[key] && trayElements[key].contains(slider)) clearTimer(key);
    }
  }, true);
  document.addEventListener("pointerup", () => {
    if (!activeSlider) return;
    const slider = activeSlider;
    activeSlider = null;
    for (const key of TRAY_KEYS) {
      if (trayElements[key] && trayElements[key].contains(slider)) scheduleAutoMinimize(key);
    }
  }, true);
  document.addEventListener("pointercancel", () => {
    activeSlider = null;
    for (const key of TRAY_KEYS) scheduleAutoMinimize(key);
  }, true);

  for (const key of TRAY_KEYS) {
    const element = trayElements[key];
    if (!element) continue;
    for (const eventName of ["pointerdown", "keydown", "input", "change", "click", "scroll"]) {
      element.addEventListener(eventName, () => {
        if (settings.expanded[key]) scheduleAutoMinimize(key);
      }, { passive: true });
    }
  }

  return {
    initialize,
    applyForDocument,
    setExpanded,
    setFocusMode,
    setAutoMinimize
  };
}
