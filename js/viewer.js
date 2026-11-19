import { getPdf, getSetting, saveLastPage, setSetting } from "./db.js";
import { perf } from "./performance.js";

const PAGE_RENDER_CACHE_LIMIT = 4;
const THUMBNAIL_CACHE_LIMIT = 12;
const TRIM_SAMPLE_WIDTH = 200;
const TRIM_CROP_CACHE_LIMIT = 8;
const DEFAULT_TRIM_PADDING = 2;

let pdfjsPromise;

function loadPdfJs() {
  if (!pdfjsPromise) {
    const importStartedAt = perf.begin();
    const pdfModuleUrl = new URL("./pdfjs/pdf.mjs", document.baseURI).href;
    pdfjsPromise = import(pdfModuleUrl).then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.mjs";
      perf.time("PDF.js module import", importStartedAt);
      return pdfjsLib;
    }).catch((error) => {
      pdfjsPromise = null;
      throw new Error(`PDF.js is unavailable. Add pdf.mjs and pdf.worker.mjs to ./pdfjs/. (${error.message})`);
    });
  }
  return pdfjsPromise;
}

export function createViewer({
  onBack,
  isAnnotating = () => false,
  onPageChange = async () => {},
  onPagesChange = async () => {},
  beforeLayoutChange = async () => {},
  onDocumentClose = async () => {},
  onPageJumpChange = () => {},
  onToolbarShow = () => {}
}) {
  const readerView = document.querySelector("#readerView");
  const pageContainer = document.querySelector("#pageContainer");
  const slots = [0, 1].map((index) => {
    const pdf = document.querySelector(index ? "#pdfCanvas1" : "#pdfCanvas");
    const ink = document.querySelector(index ? "#inkCanvas1" : "#inkCanvas");
    return {
      element: document.querySelector(`#pageSlot${index}`),
      pdf,
      ink,
      pdfContext: pdf.getContext("2d", { alpha: false })
    };
  });
  const displayModeInput = document.querySelector("#displayMode");
  const coverPageInput = document.querySelector("#showCoverPageAlone");
  const coverPageControl = document.querySelector("#coverPageControl");
  const pageFitInput = document.querySelector("#pageFitMode");
  const trimMarginsInput = document.querySelector("#trimMargins");
  const trimPaddingInput = document.querySelector("#trimPadding");
  const trimPaddingValue = document.querySelector("#trimPaddingValue");
  const resetTrimButton = document.querySelector("#resetTrimButton");
  const toolbar = document.querySelector("#readerToolbar");
  const titleElement = document.querySelector("#readerTitle");
  const pageLabel = document.querySelector("#pageLabel");
  const pageJumpPanel = document.querySelector("#pageJumpPanel");
  const pageJumpClose = document.querySelector("#pageJumpClose");
  const pageJumpForm = document.querySelector("#pageJumpForm");
  const pageJumpInput = document.querySelector("#pageJumpInput");
  const pageJumpTotal = document.querySelector("#pageJumpTotal");
  const pageJumpSlider = document.querySelector("#pageJumpSlider");
  const pageJumpSliderValue = document.querySelector("#pageJumpSliderValue");
  const pageThumbnailGrid = document.querySelector("#pageThumbnailGrid");
  const pageJumpMessage = document.querySelector("#pageJumpMessage");
  const readerMessage = document.querySelector("#readerMessage");
  const leftZone = document.querySelector("#previousZone");
  const rightZone = document.querySelector("#nextZone");
  const centerZone = document.querySelector("#centerZone");

  let pdfDocument = null;
  let loadingTask = null;
  let currentPdf = null;
  let currentPage = 1;
  let displayMode = "auto";
  let showCoverAlone = true;
  let pageFitMode = "best";
  let trimMargins = false;
  let trimPadding = DEFAULT_TRIM_PADDING;
  let resolvedTwoPage = false;
  let pageLoads = new Map();
  let pageRenders = new Map();
  let activeRenders = new Set();
  let zoneFraction = 0.3;
  let renderSequence = 0;
  let sliderDragging = false;
  let thumbnailObserver = null;
  let thumbnailRenderTask = null;
  let thumbnailIdleCancel = null;
  let thumbnailRenderQueue = Promise.resolve();
  let thumbnailGeneration = 0;
  let thumbnailsInitialized = false;
  let thumbnailCache = new Map();
  let thumbnailButtons = new Map();
  let currentThumbnailButtons = new Set();
  let preloadHandle = null;
  let preloadRenderTasks = new Set();
  let preloadCanvases = new Set();
  let preloadSequence = 0;
  let trimCropCache = new Map();
  let trimSampleQueue = [];
  let trimSampleTasks = new Set();
  let trimSampleRequested = new Set();
  let trimSampleSequence = 0;
  let trimSampleIdleHandle = null;
  let trimSampleRunningSequence = null;
  let trimSampleChanged = false;
  let trimReflowPending = false;
  let openingDocument = false;
  let settingsLoadError = null;
  const settingsReady = Promise.all([
    getSetting("displayMode", "auto"),
    getSetting("showCoverPageAlone", true),
    getSetting("pageFitMode", "best"),
    getSetting("trimMargins", false),
    getSetting("trimPadding", DEFAULT_TRIM_PADDING)
  ]).then(([savedMode, savedCover, savedFit, savedTrim, savedPadding]) => {
    displayMode = ["single", "two", "auto"].includes(savedMode) ? savedMode : "auto";
    showCoverAlone = savedCover !== false;
    pageFitMode = ["best", "width", "height"].includes(savedFit) ? savedFit : "best";
    trimMargins = savedTrim === true;
    trimPadding = Number.isFinite(savedPadding)
      ? Math.min(10, Math.max(0, savedPadding))
      : DEFAULT_TRIM_PADDING;
    displayModeInput.value = displayMode;
    coverPageInput.checked = showCoverAlone;
    pageFitInput.value = pageFitMode;
    trimMarginsInput.checked = trimMargins;
    trimPaddingInput.value = String(trimPadding);
    trimPaddingValue.value = `${trimPadding}%`;
    trimPaddingValue.textContent = `${trimPadding}%`;
    updateDisplayModeControls();
  }).catch((error) => {
    settingsLoadError = error;
    setMessage(`Could not load reader display settings: ${error.message}`);
  });

  function setMessage(text) {
    readerMessage.textContent = text;
  }

  function getTrimState(pdfId) {
    if (!trimCropCache.has(pdfId)) {
      trimCropCache.set(pdfId, { bounds: null, sampledPages: new Set() });
      while (trimCropCache.size > TRIM_CROP_CACHE_LIMIT) {
        const oldestPdfId = trimCropCache.keys().next().value;
        if (oldestPdfId === pdfId) break;
        trimCropCache.delete(oldestPdfId);
      }
    }
    const state = trimCropCache.get(pdfId);
    trimCropCache.delete(pdfId);
    trimCropCache.set(pdfId, state);
    return state;
  }

  function getDisplayCrop(bounds) {
    if (!trimMargins || !bounds) return { x: 0, y: 0, width: 1, height: 1 };
    const padding = trimPadding / 100;
    let left = Math.max(0, bounds.x - padding);
    let top = Math.max(0, bounds.y - padding);
    let right = Math.min(1, bounds.x + bounds.width + padding);
    let bottom = Math.min(1, bounds.y + bounds.height + padding);

    function enforceMinimum(start, end) {
      if (end - start >= 0.5) return [start, end];
      const center = (start + end) / 2;
      start = center - 0.25;
      end = center + 0.25;
      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > 1) {
        start -= end - 1;
        end = 1;
      }
      return [Math.max(0, start), Math.min(1, end)];
    }

    [left, right] = enforceMinimum(left, right);
    [top, bottom] = enforceMinimum(top, bottom);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function getPageCrop(pdfId) {
    if (!trimMargins) return { x: 0, y: 0, width: 1, height: 1 };
    const state = trimCropCache.get(pdfId);
    return getDisplayCrop(state && state.bounds);
  }

  function unionBounds(first, second) {
    if (!first) return second;
    const left = Math.min(first.x, second.x);
    const top = Math.min(first.y, second.y);
    const right = Math.max(first.x + first.width, second.x + second.width);
    const bottom = Math.max(first.y + first.height, second.y + second.height);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function getPageNumbers(pageNumber = currentPage, twoPage = resolvedTwoPage) {
    if (!twoPage || !pdfDocument) return [pageNumber];
    if (showCoverAlone && pageNumber === 1) return [1];
    let first = showCoverAlone
      ? 2 + 2 * Math.floor((pageNumber - 2) / 2)
      : 1 + 2 * Math.floor((pageNumber - 1) / 2);
    first = Math.max(showCoverAlone ? 2 : 1, first);
    const second = first + 1;
    return second <= pdfDocument.numPages ? [first, second] : [first];
  }

  function getSpreadAnchor(pageNumber, twoPage = resolvedTwoPage) {
    const pages = getPageNumbers(pageNumber, twoPage);
    if (twoPage && pages.length === 1 && pages[0] !== 1 && pageNumber !== 1) return pages[0];
    if (twoPage && showCoverAlone && pageNumber === 1) return 1;
    return pages[0];
  }

  function updateDisplayModeControls() {
    coverPageControl.hidden = !resolvedTwoPage;
    readerView.classList.toggle("is-two-page", resolvedTwoPage);
    readerView.classList.toggle("is-fit-width", pageFitMode === "width");
  }

  function updatePageLabel() {
    const pages = pdfDocument ? getPageNumbers() : [];
    const pageText = pages.length === 2 ? `${pages[0]}-${pages[1]}` : String(currentPage);
    pageLabel.textContent = pdfDocument ? `${pageText} / ${pdfDocument.numPages}` : "— / —";
    pageLabel.title = pdfDocument
      ? `Current ${pageText} of ${pdfDocument.numPages}. Tap to go to a page.`
      : "Page number";
    pageLabel.disabled = !pdfDocument;
    document.querySelector("#previousButton").disabled = isAnnotating() || !pdfDocument ||
      (resolvedTwoPage ? pages[0] <= 1 : currentPage <= 1);
    document.querySelector("#nextButton").disabled = isAnnotating() || !pdfDocument ||
      pages.slice(-1)[0] >= pdfDocument.numPages;
    updatePageJumpControls();
  }

  function updatePageJumpControls() {
    const pageCount = pdfDocument ? pdfDocument.numPages : 1;
    pageJumpInput.max = String(pageCount);
    pageJumpTotal.textContent = `of ${pdfDocument ? pageCount : "—"}`;
    pageJumpSlider.max = String(pageCount);
    if (!sliderDragging) {
      pageJumpInput.value = String(currentPage);
      pageJumpSlider.value = String(currentPage);
      pageJumpSliderValue.value = String(currentPage);
      pageJumpSliderValue.textContent = String(currentPage);
    }
    const nextThumbnailButtons = new Set(getPageNumbers().map((page) => thumbnailButtons.get(page)).filter(Boolean));
    for (const button of currentThumbnailButtons) {
      if (!nextThumbnailButtons.has(button)) {
        button.classList.remove("is-current", "is-spread-current");
        button.removeAttribute("aria-current");
      }
    }
    for (const button of nextThumbnailButtons) {
      button.classList.add("is-current");
      if (nextThumbnailButtons.size > 1) button.classList.add("is-spread-current");
      else button.classList.remove("is-spread-current");
      button.setAttribute("aria-current", "page");
    }
    currentThumbnailButtons = nextThumbnailButtons;
  }

  function setPageJumpMessage(text) {
    pageJumpMessage.textContent = text;
  }

  function openPagePanel(notify = true) {
    if (!pdfDocument) return;
    pageJumpPanel.hidden = false;
    pageLabel.setAttribute("aria-expanded", "true");
    setPageJumpMessage("");
    updatePageJumpControls();
    if (thumbnailsInitialized) observePendingThumbnails();
    else ensurePageThumbnails();
    if (notify) onPageJumpChange(true);
  }

  function closePagePanel(notify = true) {
    pageJumpPanel.hidden = true;
    pageLabel.setAttribute("aria-expanded", "false");
    sliderDragging = false;
    pauseThumbnailWork();
    if (notify) onPageJumpChange(false);
  }

  function togglePagePanel() {
    if (pageJumpPanel.hidden) openPagePanel();
    else closePagePanel();
  }

  function pauseThumbnailWork() {
    thumbnailGeneration += 1;
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
      thumbnailObserver = null;
    }
    if (thumbnailIdleCancel) {
      thumbnailIdleCancel();
      thumbnailIdleCancel = null;
    }
    if (thumbnailRenderTask) {
      thumbnailRenderTask.cancel();
      thumbnailRenderTask = null;
    }
  }

  function clearPageThumbnails() {
    pauseThumbnailWork();
    for (const canvas of thumbnailCache.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    thumbnailCache.clear();
    thumbnailButtons.clear();
    currentThumbnailButtons.clear();
    pageThumbnailGrid.replaceChildren();
    thumbnailsInitialized = false;
    reportMemory();
  }

  function createThumbnailPlaceholder() {
    const placeholder = document.createElement("span");
    placeholder.className = "page-thumbnail-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    return placeholder;
  }

  function runThumbnailWhenIdle(callback, generation) {
    return new Promise((resolve, reject) => {
      let completed = false;
      let idleId = null;
      let timeoutId = null;
      const finish = (handler, value) => {
        if (completed) return;
        completed = true;
        if (thumbnailIdleCancel === cancel) thumbnailIdleCancel = null;
        handler(value);
      };
      const run = () => {
        idleId = null;
        timeoutId = null;
        if (generation !== thumbnailGeneration) {
          finish(resolve);
          return;
        }
        Promise.resolve().then(callback).then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error)
        );
      };
      const cancel = () => {
        if (idleId !== null && typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(idleId);
        }
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        finish(resolve);
      };

      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(run, { timeout: 300 });
      } else {
        timeoutId = window.setTimeout(run, 40);
      }
      thumbnailIdleCancel = cancel;
    });
  }

  function queueThumbnail(pageNumber, button, generation) {
    thumbnailRenderQueue = thumbnailRenderQueue.then(async () => {
      if (
        generation !== thumbnailGeneration ||
        !pdfDocument ||
        !button.isConnected ||
        thumbnailCache.has(pageNumber)
      ) return;

      await runThumbnailWhenIdle(async () => {
        if (generation !== thumbnailGeneration || !pdfDocument || !button.isConnected) return;
        const thumbnailStartedAt = perf.begin();
        const page = await loadPage(pageNumber);
        if (generation !== thumbnailGeneration || !button.isConnected) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 120 / baseViewport.width });
        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-hidden", "true");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const placeholder = button.querySelector(".page-thumbnail-placeholder");
        if (placeholder) placeholder.replaceWith(canvas);
        else button.insertBefore(canvas, button.querySelector(".page-thumbnail-label"));
        const task = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport
        });
        thumbnailRenderTask = task;
        try {
          await task.promise;
          if (generation === thumbnailGeneration && button.isConnected) {
            thumbnailCache.set(pageNumber, canvas);
            while (thumbnailCache.size > THUMBNAIL_CACHE_LIMIT) {
              const [oldPage, oldCanvas] = thumbnailCache.entries().next().value;
              thumbnailCache.delete(oldPage);
              oldCanvas.width = 0;
              oldCanvas.height = 0;
              const oldButton = thumbnailButtons.get(oldPage);
              if (oldButton && oldCanvas.isConnected) {
                oldCanvas.replaceWith(createThumbnailPlaceholder());
                if (thumbnailObserver) thumbnailObserver.observe(oldButton);
              }
            }
            perf.time("Thumbnail generation", thumbnailStartedAt, `page ${pageNumber}`);
            reportMemory();
          }
        } finally {
          if (thumbnailRenderTask === task) thumbnailRenderTask = null;
          if (!thumbnailCache.has(pageNumber)) {
            canvas.width = 0;
            canvas.height = 0;
            if (canvas.isConnected) canvas.replaceWith(createThumbnailPlaceholder());
          }
        }
      }, generation);
    }).catch((error) => {
      if (generation === thumbnailGeneration && error.name !== "RenderingCancelledException") {
        setPageJumpMessage(`Could not render page ${pageNumber} thumbnail: ${error.message}`);
      }
    });
  }

  function ensurePageThumbnails() {
    if (!pdfDocument || thumbnailsInitialized) return;
    thumbnailsInitialized = true;
    const fragment = document.createDocumentFragment();

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const button = document.createElement("button");
      button.className = "page-thumbnail";
      button.type = "button";
      button.setAttribute("aria-label", `Go to page ${pageNumber}`);
      button.dataset.pageNumber = String(pageNumber);
      button.append(createThumbnailPlaceholder());
      const label = document.createElement("span");
      label.className = "page-thumbnail-label";
      label.textContent = String(pageNumber);
      button.append(label);
      fragment.append(button);
      thumbnailButtons.set(pageNumber, button);
    }

    pageThumbnailGrid.replaceChildren(fragment);
    updatePageJumpControls();
    observePendingThumbnails();
  }

  function observePendingThumbnails() {
    if (!pdfDocument || pageJumpPanel.hidden) return;
    const generation = thumbnailGeneration;
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const button = entry.target;
          const pageNumber = Number(button.dataset.pageNumber);
          observer.unobserve(button);
          queueThumbnail(pageNumber, button, generation);
        }
      }, {
        root: pageThumbnailGrid,
        rootMargin: "140px"
      });
      thumbnailObserver = observer;
      for (const [pageNumber, button] of thumbnailButtons) {
        if (!thumbnailCache.has(pageNumber)) thumbnailObserver.observe(button);
      }
    } else {
      for (const [pageNumber, button] of thumbnailButtons) {
        if (!thumbnailCache.has(pageNumber)) queueThumbnail(pageNumber, button, generation);
      }
    }
  }

  pageThumbnailGrid.addEventListener("click", (event) => {
    const button = event.target.closest(".page-thumbnail");
    if (button && pageThumbnailGrid.contains(button)) {
      jumpToPage(Number(button.dataset.pageNumber));
    }
  });
  function jumpToPage(pageNumber, closePanel = false) {
    if (!pdfDocument || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdfDocument.numPages) {
      return;
    }
    if (closePanel) closePagePanel();
    showToolbar();
    goToPage(pageNumber);
  }

  function showToolbar() {
    if (readerView.classList.contains("is-focus-mode")) return;
    toolbar.classList.remove("is-minimized");
    onToolbarShow();
  }

  function toggleToolbar() {
    if (isAnnotating() || readerView.classList.contains("is-focus-mode")) return;
    if (toolbar.classList.contains("is-minimized")) {
      showToolbar();
    } else {
      toolbar.classList.add("is-minimized");
    }
  }

  function updateTapZoneWidths() {
    leftZone.style.width = `${zoneFraction * 100}%`;
    rightZone.style.width = `${zoneFraction * 100}%`;
    centerZone.style.left = `${zoneFraction * 100}%`;
    centerZone.style.width = `${(1 - zoneFraction * 2) * 100}%`;
  }

  function wireTap(element, handler) {
    const starts = new Map();
    element.addEventListener("pointerdown", (event) => {
      starts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    element.addEventListener("pointerup", (event) => {
      const start = starts.get(event.pointerId);
      starts.delete(event.pointerId);
      if (!start) return;
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (distance <= 18) handler(event);
    });
    element.addEventListener("pointercancel", (event) => starts.delete(event.pointerId));
  }

  function resizeCanvas(canvas, cssWidth, cssHeight, pixelRatio) {
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
    canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
  }

  function getPixelRatio() {
    return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  }

  function getPageRenderViewport(pageInfo, pixelRatio) {
    const fullViewport = pageInfo.page.getViewport({ scale: pageInfo.scale * pixelRatio });
    return pageInfo.page.getViewport({
      scale: pageInfo.scale * pixelRatio,
      offsetX: -pageInfo.crop.x * fullViewport.width,
      offsetY: -pageInfo.crop.y * fullViewport.height
    });
  }

  function getPageRenderSize(pageInfo, pixelRatio) {
    return {
      width: Math.max(1, Math.round(pageInfo.displayWidth * pixelRatio)),
      height: Math.max(1, Math.round(pageInfo.displayHeight * pixelRatio))
    };
  }

  function getAvailableSize() {
    const bounds = pageContainer.getBoundingClientRect();
    return {
      width: Math.max(1, pageContainer.clientWidth || bounds.width),
      height: Math.max(1, pageContainer.clientHeight || bounds.height)
    };
  }

  async function calculateViewports(pageNumbers) {
    const pages = await Promise.all(pageNumbers.map((pageNumber) => loadPage(pageNumber)));
    const baseViewports = pages.map((page) => page.getViewport({ scale: 1 }));
    const available = getAvailableSize();
    const gap = resolvedTwoPage && pageNumbers.length > 1 ? 4 : 0;
    const crops = pageNumbers.map(() => getPageCrop(currentPdf.id));
    const singlePageSpreadWidth = resolvedTwoPage && baseViewports.length === 1
      ? baseViewports[0].width * crops[0].width
      : 0;
    const pageSpreadWidth = baseViewports.reduce(
      (total, viewport, index) => total + viewport.width * crops[index].width,
      singlePageSpreadWidth
    );
    const spreadHeight = Math.max(...baseViewports.map(
      (viewport, index) => viewport.height * crops[index].height
    ));
    const widthScale = Math.max(1, available.width - gap) / pageSpreadWidth;
    const heightScale = available.height / spreadHeight;
    const scale = pageFitMode === "width" ? widthScale : Math.min(widthScale, heightScale);
    return pages.map((page, index) => {
      const baseViewport = baseViewports[index];
      const crop = crops[index];
      return {
        page,
        viewport: page.getViewport({ scale }),
        crop,
        displayWidth: baseViewport.width * scale * crop.width,
        displayHeight: baseViewport.height * scale * crop.height,
        scale,
        cacheKey: [
          scale.toFixed(5),
          crop.x.toFixed(5),
          crop.y.toFixed(5),
          crop.width.toFixed(5),
          crop.height.toFixed(5)
        ].join(":")
      };
    });
  }

  function loadPage(pageNumber) {
    if (!pageLoads.has(pageNumber)) {
      const getPageStartedAt = perf.enabled ? performance.now() : 0;
      let pagePromise = pdfDocument.getPage(pageNumber);
      if (perf.enabled) {
        pagePromise = pagePromise.then((page) => {
          perf.time("PDF getPage()", getPageStartedAt, `page ${pageNumber}`);
          return page;
        });
      }
      pageLoads.set(pageNumber, pagePromise);
      while (pageLoads.size > PAGE_RENDER_CACHE_LIMIT) {
        const oldest = pageLoads.keys().next().value;
        pageLoads.delete(oldest);
      }
      pagePromise.catch(() => pageLoads.delete(pageNumber));
    }
    return pageLoads.get(pageNumber);
  }

  function disposePageRender(render) {
    if (!render || !render.canvas) return;
    render.canvas.width = 0;
    render.canvas.height = 0;
  }

  function rememberPageRender(pageNumber, canvas, cacheKey) {
    const previous = pageRenders.get(pageNumber);
    if (previous && previous.canvas !== canvas) disposePageRender(previous);
    pageRenders.delete(pageNumber);
    pageRenders.set(pageNumber, {
      canvas,
      width: canvas.width,
      height: canvas.height,
      cacheKey
    });
    while (pageRenders.size > PAGE_RENDER_CACHE_LIMIT) {
      const [oldPage, oldRender] = pageRenders.entries().next().value;
      pageRenders.delete(oldPage);
      disposePageRender(oldRender);
    }
  }

  function clearPageRenderCache() {
    for (const render of pageRenders.values()) disposePageRender(render);
    pageRenders.clear();
  }

  function cancelPreload() {
    preloadSequence += 1;
    if (preloadHandle) {
      if (preloadHandle.type === "idle" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(preloadHandle.id);
      } else {
        window.clearTimeout(preloadHandle.id);
      }
      preloadHandle = null;
    }
    for (const task of preloadRenderTasks) {
      try {
        task.cancel();
      } catch (error) {
        console.error("Could not cancel the background PDF render:", error);
      }
    }
    preloadRenderTasks.clear();
    for (const canvas of preloadCanvases) {
      disposePageRender({ canvas });
    }
    preloadCanvases.clear();
  }

  function cancelTrimSamples() {
    trimSampleSequence += 1;
    if (trimSampleIdleHandle) {
      if (trimSampleIdleHandle.type === "idle" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(trimSampleIdleHandle.id);
      } else {
        window.clearTimeout(trimSampleIdleHandle.id);
      }
      trimSampleIdleHandle = null;
    }
    trimSampleQueue = [];
    trimSampleRequested.clear();
    trimSampleRunningSequence = null;
    trimSampleChanged = false;
    trimReflowPending = false;
    for (const task of trimSampleTasks) {
      try {
        task.cancel();
      } catch (error) {
        console.error("Could not cancel a trim scan:", error);
      }
    }
    trimSampleTasks.clear();
  }

  function selectTrimSamplePages(pageCount, selectedPage) {
    const sampleCount = Math.min(10, pageCount);
    const pages = new Set([selectedPage]);
    if (sampleCount === 1) {
      pages.add(1);
    } else {
      for (let index = 0; index < sampleCount; index += 1) {
        pages.add(1 + Math.round(index * (pageCount - 1) / (sampleCount - 1)));
      }
    }
    return [...pages].sort((a, b) => a - b);
  }

  async function detectPageBounds(pageNumber, sequence) {
    const page = await loadPage(pageNumber);
    if (sequence !== trimSampleSequence || !pdfDocument) return null;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = TRIM_SAMPLE_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = TRIM_SAMPLE_WIDTH;
    sampleCanvas.height = Math.max(1, Math.round(viewport.height));
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    const task = page.render({ canvasContext: sampleContext, viewport });
    trimSampleTasks.add(task);
    try {
      await task.promise;
      if (sequence !== trimSampleSequence) return null;
      const { data, width, height } = sampleContext.getImageData(
        0,
        0,
        sampleCanvas.width,
        sampleCanvas.height
      );
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          if (data[offset + 3] > 8 && (
            data[offset] < 245 ||
            data[offset + 1] < 245 ||
            data[offset + 2] < 245
          )) {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
      }
      if (right < left || bottom < top) {
        return null;
      }
      return {
        x: left / width,
        y: top / height,
        width: (right - left + 1) / width,
        height: (bottom - top + 1) / height
      };
    } finally {
      trimSampleTasks.delete(task);
      sampleCanvas.width = 0;
      sampleCanvas.height = 0;
    }
  }

  function scheduleTrimSample() {
    if (
      trimSampleIdleHandle ||
      trimSampleRunningSequence === trimSampleSequence ||
      !trimSampleQueue.length
    ) return;
    const sequence = trimSampleSequence;
    const start = () => {
      trimSampleIdleHandle = null;
      if (sequence === trimSampleSequence) processTrimSample(sequence);
    };
    if (typeof window.requestIdleCallback === "function") {
      trimSampleIdleHandle = {
        type: "idle",
        id: window.requestIdleCallback(start, { timeout: 500 })
      };
    } else {
      trimSampleIdleHandle = {
        type: "timeout",
        id: window.setTimeout(start, 50)
      };
    }
  }

  async function processTrimSample(sequence) {
    const item = trimSampleQueue.shift();
    if (!item || sequence !== trimSampleSequence) return;
    trimSampleRunningSequence = sequence;
    let boundsChanged = false;
    try {
      const bounds = await detectPageBounds(item.pageNumber, sequence);
      if (sequence !== trimSampleSequence) return;
      const state = getTrimState(item.pdfId);
      if (bounds) {
        const union = unionBounds(state.bounds, bounds);
        boundsChanged = !state.bounds ||
          union.x !== state.bounds.x ||
          union.y !== state.bounds.y ||
          union.width !== state.bounds.width ||
          union.height !== state.bounds.height;
        state.bounds = union;
      }
      state.sampledPages.add(item.pageNumber);
    } catch (error) {
      if (sequence === trimSampleSequence && error.name !== "RenderingCancelledException") {
        setMessage(`Could not detect trim margins on page ${item.pageNumber}: ${error.message}`);
        getTrimState(item.pdfId).sampledPages.add(item.pageNumber);
      }
    } finally {
      trimSampleRequested.delete(`${item.pdfId}:${item.pageNumber}`);
      if (sequence === trimSampleSequence) {
        trimSampleChanged = trimSampleChanged || boundsChanged;
      }
      if (trimSampleRunningSequence === sequence) trimSampleRunningSequence = null;
      if (sequence === trimSampleSequence && trimSampleQueue.length) {
        scheduleTrimSample();
      } else if (
        sequence === trimSampleSequence &&
        trimSampleChanged &&
        trimMargins &&
        currentPdf &&
        currentPdf.id === item.pdfId
      ) {
        trimSampleChanged = false;
        if (isAnnotating()) {
          trimReflowPending = true;
        } else {
          clearPageRenderCache();
          renderPage(currentPage, null, true);
        }
      }
    }
  }

  function scheduleTrimSamples(pageCount, selectedPage) {
    if (!trimMargins || !currentPdf || !pdfDocument) return;
    const state = getTrimState(currentPdf.id);
    for (const pageNumber of selectTrimSamplePages(pageCount, selectedPage)) {
      const key = `${currentPdf.id}:${pageNumber}`;
      if (state.sampledPages.has(pageNumber) || trimSampleRequested.has(key)) continue;
      trimSampleRequested.add(key);
      trimSampleQueue.push({ pdfId: currentPdf.id, pageNumber });
    }
    scheduleTrimSample();
  }

  function schedulePreload(pageNumber) {
    cancelPreload();
    if (!pdfDocument || pageNumber > pdfDocument.numPages) return;
    const sequence = preloadSequence;
    const start = () => {
      preloadHandle = null;
      preloadPage(pageNumber, sequence);
    };
    if (typeof window.requestIdleCallback === "function") {
      preloadHandle = {
        type: "idle",
        id: window.requestIdleCallback(start, { timeout: 500 })
      };
    } else {
      preloadHandle = {
        type: "timeout",
        id: window.setTimeout(start, 50)
      };
    }
  }

  function reportMemory() {
    if (!perf.enabled) return;
    const pageCacheBytes = [...pageRenders.values()].reduce(
      (total, render) => total + render.width * render.height * 4,
      0
    );
    const thumbnailCacheBytes = [...thumbnailCache.values()].reduce(
      (total, canvas) => total + canvas.width * canvas.height * 4,
      0
    );
    perf.memory({
      liveCanvases: document.querySelectorAll("canvas").length,
      cachedPageBitmaps: pageRenders.size,
      cachedPageBytes: pageCacheBytes,
      thumbnailCacheEntries: thumbnailCache.size,
      thumbnailCacheBytes,
      loadedPageObjects: pageLoads.size,
      storedBufferBytes: currentPdf && currentPdf.data instanceof ArrayBuffer
        ? currentPdf.data.byteLength
        : 0
    });
  }

  async function renderOnePage(pageNumber, slot, pageInfo, sequence) {
    const pixelRatio = getPixelRatio();
    const { width, height } = getPageRenderSize(pageInfo, pixelRatio);
    const cacheKey = `${pageInfo.cacheKey}:${pixelRatio}`;
    resizeCanvas(slot.pdf, pageInfo.displayWidth, pageInfo.displayHeight, pixelRatio);
    resizeCanvas(slot.ink, pageInfo.displayWidth, pageInfo.displayHeight, pixelRatio);
    const cached = pageRenders.get(pageNumber);
    let renderedFromCache = false;
    if (
      cached &&
      cached.width === width &&
      cached.height === height &&
      cached.cacheKey === cacheKey
    ) {
      slot.pdfContext.setTransform(1, 0, 0, 1, 0, 0);
      slot.pdfContext.drawImage(cached.canvas, 0, 0);
      pageRenders.delete(pageNumber);
      pageRenders.set(pageNumber, cached);
      renderedFromCache = true;
    } else {
      const renderTask = pageInfo.page.render({
        canvasContext: slot.pdfContext,
        viewport: getPageRenderViewport(pageInfo, pixelRatio)
      });
      activeRenders.add(renderTask);
      try {
        await renderTask.promise;
      } finally {
        activeRenders.delete(renderTask);
      }
      if (sequence !== renderSequence) return false;
      cacheRenderedPage(pageNumber, slot.pdf, cacheKey);
    }
    return renderedFromCache;
  }

  async function renderPage(pageNumber, pageTurn = null, preserveScroll = false) {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) return;
    const sequence = ++renderSequence;
    const scrollTop = preserveScroll ? pageContainer.scrollTop : 0;
    cancelPreload();
    for (const render of activeRenders) {
      try {
        render.cancel();
      } catch (error) {
        console.error("Could not cancel the active PDF render:", error);
      }
    }
    activeRenders.clear();

    currentPage = pageNumber;
    trimReflowPending = false;
    if (!preserveScroll) pageContainer.scrollTop = 0;
    updatePageLabel();
    setMessage("");
    try {
      const firstPageRender = openingDocument;
      const firstRenderStartedAt = perf.begin();
      const pageNumbers = getPageNumbers(currentPage);
      const pageInfos = await calculateViewports(pageNumbers);
      if (sequence !== renderSequence) return;
      slots.forEach((slot) => {
        slot.element.hidden = true;
        slot.element.classList.remove("is-blank");
        slot.element.style.width = "";
        slot.element.style.height = "";
      });
      const gap = resolvedTwoPage && pageNumbers.length > 1 ? 4 : 0;
      pageContainer.style.gap = `${gap}px`;
      const lonePage = resolvedTwoPage && pageNumbers.length === 1;
      const spreadHeight = Math.ceil(Math.max(...pageInfos.map((info) => info.displayHeight)));
      readerView.classList.toggle(
        "is-fit-width-tall",
        pageFitMode === "width" && spreadHeight > pageContainer.clientHeight + 1
      );
      let renderedFromCache = true;
      const visiblePageRecords = [];
      const renders = pageInfos.map(async (pageInfo, index) => {
        const pageNumberForSlot = pageNumbers[index];
        let slotIndex = index;
        if (lonePage) {
          slotIndex = (showCoverAlone && pageNumberForSlot === 1) ||
            (!showCoverAlone && pageNumberForSlot % 2 === 1) ? 1 : 0;
        }
        const slot = slots[slotIndex];
        slot.element.hidden = false;
        slot.element.classList.remove("is-blank");
        slot.element.style.width = `${pageInfo.displayWidth}px`;
        slot.element.style.height = `${resolvedTwoPage ? spreadHeight : pageInfo.displayHeight}px`;
        slot.pdf.dataset.pageNumber = String(pageNumberForSlot);
        slot.ink.dataset.pageNumber = String(pageNumberForSlot);
        slot.pdf.dataset.cropX = String(pageInfo.crop.x);
        slot.pdf.dataset.cropY = String(pageInfo.crop.y);
        slot.pdf.dataset.cropWidth = String(pageInfo.crop.width);
        slot.pdf.dataset.cropHeight = String(pageInfo.crop.height);
        slot.ink.dataset.cropX = String(pageInfo.crop.x);
        slot.ink.dataset.cropY = String(pageInfo.crop.y);
        slot.ink.dataset.cropWidth = String(pageInfo.crop.width);
        slot.ink.dataset.cropHeight = String(pageInfo.crop.height);
        visiblePageRecords.push({ pageNumber: pageNumberForSlot, canvas: slot.ink });
        const pageStartedAt = perf.begin();
        const fromCache = await renderOnePage(pageNumberForSlot, slot, pageInfo, sequence);
        renderedFromCache = renderedFromCache && fromCache;
        perf.time(fromCache ? "Rendered page cache draw" : "PDF canvas render", pageStartedAt, `page ${pageNumberForSlot}`);
        return slot;
      });
      const renderedSlots = await Promise.all(renders);
      if (sequence !== renderSequence) return;
      pageContainer.scrollTop = scrollTop;
      if (lonePage) {
        const visibleSlot = renderedSlots[0];
        const blankSlot = slots.find((slot) => slot !== visibleSlot);
        blankSlot.element.hidden = false;
        blankSlot.element.classList.add("is-blank");
        blankSlot.element.style.width = visibleSlot.element.style.width;
        blankSlot.element.style.height = visibleSlot.element.style.height;
        blankSlot.pdf.style.width = "0px";
        blankSlot.pdf.style.height = "0px";
        blankSlot.ink.style.width = "0px";
        blankSlot.ink.style.height = "0px";
        blankSlot.pdf.width = 1;
        blankSlot.pdf.height = 1;
        blankSlot.ink.width = 1;
        blankSlot.ink.height = 1;
        delete blankSlot.pdf.dataset.pageNumber;
        delete blankSlot.ink.dataset.pageNumber;
        delete blankSlot.pdf.dataset.cropX;
        delete blankSlot.pdf.dataset.cropY;
        delete blankSlot.pdf.dataset.cropWidth;
        delete blankSlot.pdf.dataset.cropHeight;
        delete blankSlot.ink.dataset.cropX;
        delete blankSlot.ink.dataset.cropY;
        delete blankSlot.ink.dataset.cropWidth;
        delete blankSlot.ink.dataset.cropHeight;
      }
      await onPagesChange(currentPdf.id, visiblePageRecords);
      if (sequence !== renderSequence) return;
      await onPageChange(currentPdf.id, currentPage);
      if (sequence !== renderSequence) return;
      if (firstPageRender) {
        openingDocument = false;
        perf.time("PDF first page + annotations visible", firstRenderStartedAt);
      }
      if (pageTurn) {
        perf.time(
          renderedFromCache ? "Page turn visible (cached)" : "Page turn visible (uncached)",
          pageTurn.startedAt,
          `page ${currentPage}`
        );
      }
      saveLastPage(currentPdf.id, getSpreadAnchor(currentPage), pdfDocument.numPages).catch((error) => {
        setMessage(`Could not save your place: ${error.message}`);
      });
      reportMemory();
      const nextAnchor = resolvedTwoPage
        ? getPageNumbers(currentPage).slice(-1)[0] + 1
        : currentPage + 1;
      schedulePreload(nextAnchor);
    } catch (error) {
      if (openingDocument) openingDocument = false;
      if (error.name !== "RenderingCancelledException") {
        setMessage(`Could not render page: ${error.message}`);
      }
    }
  }

  function cacheRenderedPage(pageNumber, sourceCanvas, cacheKey) {
    const cachedCanvas = document.createElement("canvas");
    cachedCanvas.width = sourceCanvas.width;
    cachedCanvas.height = sourceCanvas.height;
    cachedCanvas.getContext("2d").drawImage(sourceCanvas, 0, 0);
    rememberPageRender(pageNumber, cachedCanvas, cacheKey);
  }

  function preloadPage(pageNumber, sequence) {
    if (!pdfDocument || sequence !== preloadSequence || pageNumber > pdfDocument.numPages) return;
    const preloadStartedAt = perf.begin();
    const pageNumbers = getPageNumbers(pageNumber);
    calculateViewports(pageNumbers).then(async (pageInfos) => {
      if (!pdfDocument || sequence !== preloadSequence) return;
      await Promise.all(pageInfos.map(async (pageInfo, index) => {
        const targetPage = pageNumbers[index];
        if (pageRenders.has(targetPage)) return;
        const pixelRatio = getPixelRatio();
        const canvas = document.createElement("canvas");
        const size = getPageRenderSize(pageInfo, pixelRatio);
        canvas.width = size.width;
        canvas.height = size.height;
        preloadCanvases.add(canvas);
        const task = pageInfo.page.render({
          canvasContext: canvas.getContext("2d"),
          viewport: getPageRenderViewport(pageInfo, pixelRatio)
        });
        preloadRenderTasks.add(task);
        try {
          await task.promise;
          if (pdfDocument && sequence === preloadSequence) {
            rememberPageRender(targetPage, canvas, `${pageInfo.cacheKey}:${pixelRatio}`);
            preloadCanvases.delete(canvas);
          } else {
            disposePageRender({ canvas });
            preloadCanvases.delete(canvas);
          }
        } finally {
          preloadRenderTasks.delete(task);
        }
      }));
      if (sequence === preloadSequence) {
        perf.time("Background spread render", preloadStartedAt, `page ${pageNumber}`);
        reportMemory();
      }
    }).catch((error) => {
      if (sequence === preloadSequence && error.name !== "RenderingCancelledException") {
        setMessage(`Could not prepare the next spread: ${error.message}`);
      }
    });
  }

  async function open(pdfId) {
    const openStartedAt = perf.begin();
    await closeDocument();
    await settingsReady;
    readerView.classList.add("is-active");
    readerView.setAttribute("aria-hidden", "false");
    setMessage("Opening PDF…");
    try {
      let record;
      const readStartedAt = perf.begin();
      try {
        record = await getPdf(pdfId);
      } catch (error) {
        throw new Error(`Could not read PDF from storage: ${error.message}`);
      }
      perf.time("PDF IndexedDB read", readStartedAt, record && record.data instanceof ArrayBuffer
        ? `${record.data.byteLength} bytes`
        : "record missing");
      if (!record) throw new Error("This PDF is no longer in the library.");
      if ("blob" in record) {
        throw new Error("This PDF uses the old storage format. Please delete it and re-import it from the Files app.");
      }
      if (!(record.data instanceof ArrayBuffer)) {
        throw new Error("The stored PDF data is missing or invalid. Please re-import this PDF from the Files app.");
      }

      currentPdf = record;
      const pdfjsLib = await loadPdfJs();
      const copyStartedAt = perf.begin();
      const data = new Uint8Array(record.data.slice(0));
      perf.time("PDF buffer copy", copyStartedAt, `${data.byteLength} bytes`);
      const documentLoadStartedAt = perf.begin();
      loadingTask = pdfjsLib.getDocument({ data });
      pdfDocument = await loadingTask.promise;
      perf.time("PDF getDocument()", documentLoadStartedAt, `${pdfDocument.numPages} pages`);
      currentPdf.pageCount = pdfDocument.numPages;
      titleElement.textContent = currentPdf.name;
      titleElement.title = currentPdf.name;
      const requestedPage = Math.min(Math.max(1, currentPdf.lastPage || 1), pdfDocument.numPages);
      resolvedTwoPage = displayMode === "two" ||
        (displayMode === "auto" && window.innerWidth > window.innerHeight);
      updateDisplayModeControls();
      pageLoads = new Map();
      pageRenders = new Map();
      openingDocument = true;
      await renderPage(requestedPage);
      if (trimMargins) scheduleTrimSamples(pdfDocument.numPages, requestedPage);
      if (settingsLoadError) {
        setMessage(`Could not load reader display settings: ${settingsLoadError.message}`);
      }
      perf.time("PDF open total", openStartedAt, `${pdfDocument.numPages} pages`);
    } catch (error) {
      openingDocument = false;
      setMessage(`Could not open PDF: ${error.message}`);
    }
  }

  async function closeDocument() {
    renderSequence += 1;
    cancelPreload();
    cancelTrimSamples();
    pageJumpPanel.hidden = true;
    pageLabel.setAttribute("aria-expanded", "false");
    sliderDragging = false;
    clearPageThumbnails();
    for (const render of activeRenders) {
      try {
        render.cancel();
      } catch (error) {
        console.error("Could not cancel the active PDF render:", error);
      }
    }
    activeRenders.clear();
    try {
      await onDocumentClose();
    } catch (error) {
      setMessage(`Could not flush annotations while closing the PDF: ${error.message}`);
    }
    try {
      if (loadingTask) {
        await loadingTask.destroy();
      } else if (pdfDocument && typeof pdfDocument.destroy === "function") {
        await pdfDocument.destroy();
      }
    } catch (error) {
      console.error("Could not clean up the PDF document:", error);
    }
    pdfDocument = null;
    loadingTask = null;
    pageLoads.clear();
    clearPageRenderCache();
    currentPdf = null;
    currentPage = 1;
    openingDocument = false;
    for (const slot of slots) {
      slot.element.hidden = true;
      slot.element.classList.remove("is-blank");
      slot.element.style.width = "";
      slot.element.style.height = "";
      slot.pdf.width = 1;
      slot.pdf.height = 1;
      slot.ink.width = 1;
      slot.ink.height = 1;
      slot.pdf.style.width = "";
      slot.pdf.style.height = "";
      slot.ink.style.width = "";
      slot.ink.style.height = "";
      delete slot.pdf.dataset.pageNumber;
      delete slot.ink.dataset.pageNumber;
      delete slot.pdf.dataset.cropX;
      delete slot.pdf.dataset.cropY;
      delete slot.pdf.dataset.cropWidth;
      delete slot.pdf.dataset.cropHeight;
      delete slot.ink.dataset.cropX;
      delete slot.ink.dataset.cropY;
      delete slot.ink.dataset.cropWidth;
      delete slot.ink.dataset.cropHeight;
    }
    pageContainer.style.gap = "0px";
    readerView.classList.remove("is-fit-width-tall");
    pageContainer.scrollTop = 0;
    updatePageLabel();
    reportMemory();
  }

  async function goToPage(pageNumber) {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) return;
    await renderPage(pageNumber, perf.enabled ? { startedAt: performance.now() } : null);
  }

  function navigate(delta) {
    if (!pdfDocument || isAnnotating()) return;
    const visiblePages = getPageNumbers();
    const targetPage = resolvedTwoPage
      ? delta > 0
        ? visiblePages[visiblePages.length - 1] + 1
        : visiblePages[0] - 1
      : currentPage + delta;
    if (targetPage < 1 || targetPage > pdfDocument.numPages) return;
    showToolbar();
    goToPage(resolvedTwoPage ? getSpreadAnchor(targetPage) : targetPage);
  }

  function handleTapZone(event) {
    if (!pdfDocument || isAnnotating()) return;
    const x = event.clientX / window.innerWidth;
    if (x < zoneFraction) {
      navigate(-1);
    } else if (x > 1 - zoneFraction) {
      navigate(1);
    } else {
      showToolbar();
    }
  }

  function handleFitWidthTap(event) {
    const x = event.clientX / window.innerWidth;
    if (x >= zoneFraction && x <= 1 - zoneFraction) {
      toggleToolbar();
    } else {
      handleTapZone(event);
    }
  }

  function handlePagePanelOutside(event) {
    if (pageJumpPanel.hidden) return;
    const target = event.target;
    if (pageJumpPanel.contains(target) || pageLabel.contains(target)) return;
    closePagePanel();
    if (!target.closest("#readerToolbar, #metronomePanel, #recorderPanel, #annotationToolbar, #focusRestoreButton, #pageContainer, .ink-canvas")) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  pageLabel.addEventListener("click", togglePagePanel);
  pageJumpClose.addEventListener("click", closePagePanel);
  pageJumpPanel.addEventListener("click", (event) => event.stopPropagation());
  readerView.addEventListener("pointerdown", handlePagePanelOutside, true);

  pageJumpForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const pageNumber = Number(pageJumpInput.value);
    if (
      !pdfDocument ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > pdfDocument.numPages
    ) {
      pageJumpInput.setCustomValidity(
        `Enter a page number from 1 to ${pdfDocument ? pdfDocument.numPages : 1}.`
      );
      pageJumpInput.reportValidity();
      setPageJumpMessage("Enter a page within the displayed range.");
      return;
    }
    pageJumpInput.setCustomValidity("");
    setPageJumpMessage("");
    jumpToPage(pageNumber, true);
  });

  pageJumpInput.addEventListener("input", () => {
    pageJumpInput.setCustomValidity("");
    setPageJumpMessage("");
  });
  pageJumpSlider.addEventListener("pointerdown", () => {
    sliderDragging = true;
  });
  pageJumpSlider.addEventListener("pointercancel", () => {
    sliderDragging = false;
    updatePageJumpControls();
  });
  pageJumpSlider.addEventListener("input", () => {
    const pageNumber = Number(pageJumpSlider.value);
    pageJumpSliderValue.value = String(pageNumber);
    pageJumpSliderValue.textContent = String(pageNumber);
    pageJumpInput.value = String(pageNumber);
  });
  pageJumpSlider.addEventListener("change", () => {
    sliderDragging = false;
    jumpToPage(Number(pageJumpSlider.value));
  });

  document.querySelector("#previousButton").addEventListener("click", () => navigate(-1));
  document.querySelector("#nextButton").addEventListener("click", () => navigate(1));
  wireTap(leftZone, handleTapZone);
  wireTap(rightZone, handleTapZone);
  wireTap(centerZone, toggleToolbar);
  wireTap(pageContainer, handleFitWidthTap);
  document.querySelector("#backButton").addEventListener("click", async () => {
    try {
      if (currentPdf && pdfDocument) {
        await saveLastPage(currentPdf.id, getSpreadAnchor(currentPage), pdfDocument.numPages);
      }
    } catch (error) {
      setMessage(`Could not save your place: ${error.message}`);
    }
    try {
      await closeDocument();
    } finally {
      readerView.classList.remove("is-active");
      readerView.setAttribute("aria-hidden", "true");
      await onBack();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!readerView.classList.contains("is-active")) return;
    if (event.key === "ArrowLeft") navigate(-1);
    if (event.key === "ArrowRight") navigate(1);
    if (event.key === "Escape") {
      if (!pageJumpPanel.hidden) closePagePanel();
      else document.querySelector("#backButton").click();
    }
  });

  let resizeTimer = null;
  function scheduleLayoutUpdate(clearCache = true) {
    if (!pdfDocument) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(async () => {
      const nextTwoPage = displayMode === "two" ||
        (displayMode === "auto" && window.innerWidth > window.innerHeight);
      let saveError = null;
      if (nextTwoPage !== resolvedTwoPage) {
        try {
          await beforeLayoutChange();
        } catch (error) {
          saveError = error;
        }
        resolvedTwoPage = nextTwoPage;
        updateDisplayModeControls();
      }
      if (clearCache) clearPageRenderCache();
      await renderPage(currentPage, null, !clearCache);
      if (saveError) {
        setMessage(`Could not save annotations before changing display mode: ${saveError.message}`);
      }
    }, 100);
  }
  window.addEventListener("resize", scheduleLayoutUpdate);
  window.addEventListener("orientationchange", scheduleLayoutUpdate);
  readerView.addEventListener("readerlayoutchange", () => scheduleLayoutUpdate(false));

  async function changeDisplayMode() {
    const nextMode = displayModeInput.value;
    if (!["single", "two", "auto"].includes(nextMode) || nextMode === displayMode) return;
    let saveError = null;
    try {
      await beforeLayoutChange();
    } catch (error) {
      saveError = error;
    }
    displayMode = nextMode;
    try {
      await setSetting("displayMode", displayMode);
    } catch (error) {
      saveError = error;
    }
    const nextTwoPage = displayMode === "two" ||
      (displayMode === "auto" && window.innerWidth > window.innerHeight);
    if (resolvedTwoPage !== nextTwoPage) clearPageRenderCache();
    resolvedTwoPage = nextTwoPage;
    updateDisplayModeControls();
    if (pdfDocument) await renderPage(currentPage, null, true);
    if (saveError) setMessage(`Could not save display mode or annotations: ${saveError.message}`);
  }

  displayModeInput.addEventListener("change", changeDisplayMode);
  pageFitInput.addEventListener("change", async () => {
    const nextMode = pageFitInput.value;
    if (!["best", "width", "height"].includes(nextMode) || nextMode === pageFitMode) return;
    pageFitMode = nextMode;
    updateDisplayModeControls();
    try {
      await setSetting("pageFitMode", pageFitMode);
    } catch (error) {
      setMessage(`Could not save page fit setting: ${error.message}`);
    }
    if (pdfDocument) await renderPage(currentPage);
  });
  trimMarginsInput.addEventListener("change", async () => {
    trimMargins = trimMarginsInput.checked;
    trimReflowPending = false;
    try {
      await setSetting("trimMargins", trimMargins);
    } catch (error) {
      setMessage(`Could not save trim margins setting: ${error.message}`);
    }
    if (!pdfDocument) return;
    if (trimMargins) scheduleTrimSamples(pdfDocument.numPages, currentPage);
    await renderPage(currentPage, null, true);
  });
  trimPaddingInput.addEventListener("input", () => {
    trimPadding = Math.min(10, Math.max(0, Number(trimPaddingInput.value)));
    trimPaddingValue.value = `${trimPadding}%`;
    trimPaddingValue.textContent = `${trimPadding}%`;
  });
  trimPaddingInput.addEventListener("change", async () => {
    try {
      await setSetting("trimPadding", trimPadding);
    } catch (error) {
      setMessage(`Could not save trim padding setting: ${error.message}`);
    }
    if (pdfDocument) await renderPage(currentPage, null, true);
  });
  resetTrimButton.addEventListener("click", async () => {
    if (currentPdf) {
      cancelTrimSamples();
      trimCropCache.delete(currentPdf.id);
    }
    trimPadding = DEFAULT_TRIM_PADDING;
    trimPaddingInput.value = String(trimPadding);
    trimPaddingValue.value = `${trimPadding}%`;
    trimPaddingValue.textContent = `${trimPadding}%`;
    try {
      await setSetting("trimPadding", trimPadding);
    } catch (error) {
      setMessage(`Could not reset trim padding: ${error.message}`);
    }
    if (!pdfDocument) return;
    if (trimMargins) scheduleTrimSamples(pdfDocument.numPages, currentPage);
    clearPageRenderCache();
    await renderPage(currentPage, null, true);
  });
  coverPageInput.addEventListener("change", async () => {
    const previous = showCoverAlone;
    showCoverAlone = coverPageInput.checked;
    try {
      await beforeLayoutChange();
      await setSetting("showCoverPageAlone", showCoverAlone);
    } catch (error) {
      showCoverAlone = previous;
      coverPageInput.checked = previous;
      setMessage(`Could not save cover page setting: ${error.message}`);
      return;
    }
    if (resolvedTwoPage && pdfDocument) {
      clearPageRenderCache();
      renderPage(currentPage, null, true);
    }
  });

  getSetting("tapZoneWidth", zoneFraction).then((savedZoneWidth) => {
    if (Number.isFinite(savedZoneWidth)) zoneFraction = Math.min(0.45, Math.max(0.15, savedZoneWidth));
    updateTapZoneWidths();
  }).catch((error) => {
    setMessage(`Could not load reader settings: ${error.message}`);
  });

  function setAnnotationMode(active) {
    readerView.classList.toggle("is-annotating", active);
    updatePageLabel();
    if (!active && trimReflowPending) {
      trimReflowPending = false;
      clearPageRenderCache();
      renderPage(currentPage, null, true);
    }
  }

  function setPagePanelExpanded(expanded, notify = true) {
    if (expanded) openPagePanel(notify);
    else closePagePanel(notify);
  }

  function hasDocument() {
    return Boolean(pdfDocument);
  }

  async function refreshLayout() {
    if (!pdfDocument) return;
    clearPageRenderCache();
    await renderPage(currentPage);
  }

  return { open, refreshLayout, setAnnotationMode, setPagePanelExpanded, hasDocument };
}
