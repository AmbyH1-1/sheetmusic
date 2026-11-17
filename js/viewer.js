import { getPdf, getSetting, saveLastPage, setSetting } from "./db.js";
import { perf } from "./performance.js";

const PAGE_RENDER_CACHE_LIMIT = 4;
const THUMBNAIL_CACHE_LIMIT = 12;

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
  let openingDocument = false;
  let settingsLoadError = null;
  const settingsReady = Promise.all([
    getSetting("displayMode", "auto"),
    getSetting("showCoverPageAlone", true)
  ]).then(([savedMode, savedCover]) => {
    displayMode = ["single", "two", "auto"].includes(savedMode) ? savedMode : "auto";
    showCoverAlone = savedCover !== false;
    displayModeInput.value = displayMode;
    coverPageInput.checked = showCoverAlone;
    updateDisplayModeControls();
  }).catch((error) => {
    settingsLoadError = error;
    setMessage(`Could not load reader display settings: ${error.message}`);
  });

  function setMessage(text) {
    readerMessage.textContent = text;
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

  function getAvailableSize() {
    const bounds = pageContainer.getBoundingClientRect();
    const toolbarPadding = readerView.classList.contains("is-focus-mode")
      ? 0
      : toolbar.getBoundingClientRect().height + 8;
    return {
      width: Math.max(1, bounds.width - 12),
      height: Math.max(1, bounds.height - toolbarPadding)
    };
  }

  async function calculateViewports(pageNumbers) {
    const pages = await Promise.all(pageNumbers.map((pageNumber) => loadPage(pageNumber)));
    const baseViewports = pages.map((page) => page.getViewport({ scale: 1 }));
    const available = getAvailableSize();
    const gap = resolvedTwoPage ? 8 : 0;
    const pageWidth = resolvedTwoPage ? Math.max(1, (available.width - gap) / 2) : available.width;
    return pages.map((page, index) => {
      const baseViewport = baseViewports[index];
      const scale = Math.min(
        available.height / baseViewport.height,
        pageWidth / baseViewport.width
      );
      return {
        page,
        viewport: page.getViewport({ scale }),
        scale
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

  function rememberPageRender(pageNumber, canvas) {
    const previous = pageRenders.get(pageNumber);
    if (previous && previous.canvas !== canvas) disposePageRender(previous);
    pageRenders.delete(pageNumber);
    pageRenders.set(pageNumber, {
      canvas,
      width: canvas.width,
      height: canvas.height
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
    const { page, viewport } = pageInfo;
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    resizeCanvas(slot.pdf, width, height, pixelRatio);
    resizeCanvas(slot.ink, width, height, pixelRatio);
    const cached = pageRenders.get(pageNumber);
    let renderedFromCache = false;
    if (cached && cached.width === slot.pdf.width && cached.height === slot.pdf.height) {
      slot.pdfContext.setTransform(1, 0, 0, 1, 0, 0);
      slot.pdfContext.drawImage(cached.canvas, 0, 0);
      pageRenders.delete(pageNumber);
      pageRenders.set(pageNumber, cached);
      renderedFromCache = true;
    } else {
      const renderTask = page.render({
        canvasContext: slot.pdfContext,
        viewport: page.getViewport({ scale: viewport.scale * pixelRatio })
      });
      activeRenders.add(renderTask);
      try {
        await renderTask.promise;
      } finally {
        activeRenders.delete(renderTask);
      }
      if (sequence !== renderSequence) return false;
      cacheRenderedPage(pageNumber, slot.pdf);
    }
    return renderedFromCache;
  }

  async function renderPage(pageNumber, pageTurn = null) {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) return;
    const sequence = ++renderSequence;
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
      const gap = resolvedTwoPage ? 8 : 0;
      pageContainer.style.gap = `${gap}px`;
      const lonePage = resolvedTwoPage && pageNumbers.length === 1;
      const spreadHeight = Math.ceil(Math.max(...pageInfos.map((info) => info.viewport.height)));
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
        slot.element.style.width = `${Math.ceil(pageInfo.viewport.width)}px`;
        slot.element.style.height = `${resolvedTwoPage ? spreadHeight : Math.ceil(pageInfo.viewport.height)}px`;
        slot.pdf.dataset.pageNumber = String(pageNumberForSlot);
        slot.ink.dataset.pageNumber = String(pageNumberForSlot);
        visiblePageRecords.push({ pageNumber: pageNumberForSlot, canvas: slot.ink });
        const pageStartedAt = perf.begin();
        const fromCache = await renderOnePage(pageNumberForSlot, slot, pageInfo, sequence);
        renderedFromCache = renderedFromCache && fromCache;
        perf.time(fromCache ? "Rendered page cache draw" : "PDF canvas render", pageStartedAt, `page ${pageNumberForSlot}`);
        return slot;
      });
      const renderedSlots = await Promise.all(renders);
      if (sequence !== renderSequence) return;
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

  function cacheRenderedPage(pageNumber, sourceCanvas) {
    const cachedCanvas = document.createElement("canvas");
    cachedCanvas.width = sourceCanvas.width;
    cachedCanvas.height = sourceCanvas.height;
    cachedCanvas.getContext("2d").drawImage(sourceCanvas, 0, 0);
    rememberPageRender(pageNumber, cachedCanvas);
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
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(pageInfo.viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.round(pageInfo.viewport.height * pixelRatio));
        preloadCanvases.add(canvas);
        const task = pageInfo.page.render({
          canvasContext: canvas.getContext("2d"),
          viewport: pageInfo.page.getViewport({ scale: pageInfo.viewport.scale * pixelRatio })
        });
        preloadRenderTasks.add(task);
        try {
          await task.promise;
          if (pdfDocument && sequence === preloadSequence) {
            rememberPageRender(targetPage, canvas);
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
    }
    pageContainer.style.gap = "0px";
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

  function handlePagePanelOutside(event) {
    if (pageJumpPanel.hidden) return;
    const target = event.target;
    if (pageJumpPanel.contains(target) || pageLabel.contains(target)) return;
    closePagePanel();
    if (!target.closest("#readerToolbar, #metronomePanel, #recorderPanel, #annotationToolbar, #focusRestoreButton")) {
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
  function scheduleLayoutUpdate() {
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
      clearPageRenderCache();
      await renderPage(currentPage);
      if (saveError) {
        setMessage(`Could not save annotations before changing display mode: ${saveError.message}`);
      }
    }, 100);
  }
  window.addEventListener("resize", scheduleLayoutUpdate);
  window.addEventListener("orientationchange", scheduleLayoutUpdate);

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
    if (pdfDocument) await renderPage(currentPage);
    if (saveError) setMessage(`Could not save display mode or annotations: ${saveError.message}`);
  }

  displayModeInput.addEventListener("change", changeDisplayMode);
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
      renderPage(currentPage);
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
