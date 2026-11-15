import { getPdf, getSetting, saveLastPage } from "./db.js";
import { perf } from "./performance.js";

const PAGE_RENDER_CACHE_LIMIT = 3;
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
  onPageJumpChange = () => {},
  onToolbarShow = () => {}
}) {
  const readerView = document.querySelector("#readerView");
  const pageContainer = document.querySelector("#pageContainer");
  const pdfCanvas = document.querySelector("#pdfCanvas");
  const inkCanvas = document.querySelector("#inkCanvas");
  const pdfContext = pdfCanvas.getContext("2d", { alpha: false });
  const inkContext = inkCanvas.getContext("2d");
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
  let pageLoads = new Map();
  let pageRenders = new Map();
  let activeRender = null;
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
  let currentThumbnailButton = null;
  let preloadHandle = null;
  let preloadRenderTask = null;
  let preloadCanvas = null;
  let preloadSequence = 0;
  let openingDocument = false;

  function setMessage(text) {
    readerMessage.textContent = text;
  }

  function updatePageLabel() {
    pageLabel.textContent = pdfDocument ? `${currentPage} / ${pdfDocument.numPages}` : "— / —";
    pageLabel.title = pdfDocument
      ? `Current page ${currentPage} of ${pdfDocument.numPages}. Tap to go to a page.`
      : "Page number";
    pageLabel.disabled = !pdfDocument;
    document.querySelector("#previousButton").disabled = isAnnotating() || !pdfDocument || currentPage <= 1;
    document.querySelector("#nextButton").disabled = isAnnotating() || !pdfDocument || currentPage >= pdfDocument.numPages;
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
    const nextThumbnailButton = thumbnailButtons.get(currentPage) || null;
    if (currentThumbnailButton !== nextThumbnailButton) {
      if (currentThumbnailButton) {
        currentThumbnailButton.classList.remove("is-current");
        currentThumbnailButton.removeAttribute("aria-current");
      }
      currentThumbnailButton = nextThumbnailButton;
      if (currentThumbnailButton) {
        currentThumbnailButton.classList.add("is-current");
        currentThumbnailButton.setAttribute("aria-current", "page");
      }
    }
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
    currentThumbnailButton = null;
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

  function calculateViewport(page) {
    const baseViewport = page.getViewport({ scale: 1 });
    const bounds = pageContainer.getBoundingClientRect();
    const toolbarPadding = readerView.classList.contains("is-focus-mode")
      ? 0
      : toolbar.getBoundingClientRect().height + 8;
    const availableWidth = Math.max(1, bounds.width - 12);
    const availableHeight = Math.max(1, bounds.height - toolbarPadding);
    const scale = Math.min(availableHeight / baseViewport.height, availableWidth / baseViewport.width);
    return page.getViewport({ scale });
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
    if (preloadRenderTask) {
      try {
        preloadRenderTask.cancel();
      } catch (error) {
        console.error("Could not cancel the background PDF render:", error);
      }
      preloadRenderTask = null;
    }
    if (preloadCanvas) {
      disposePageRender({ canvas: preloadCanvas });
      preloadCanvas = null;
    }
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

  async function renderPage(pageNumber, pageTurn = null) {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) return;
    const sequence = ++renderSequence;
    cancelPreload();
    if (activeRender) {
      activeRender.cancel();
      activeRender = null;
    }

    currentPage = pageNumber;
    updatePageLabel();
    setMessage("");
    try {
      const firstPageRender = openingDocument;
      const firstRenderStartedAt = perf.begin();
      const page = await loadPage(pageNumber);
      if (sequence !== renderSequence) return;
      const viewport = calculateViewport(page);
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      resizeCanvas(pdfCanvas, width, height, pixelRatio);
      resizeCanvas(inkCanvas, width, height, pixelRatio);

      const cached = pageRenders.get(pageNumber);
      let renderedFromCache = false;
      if (cached && cached.width === pdfCanvas.width && cached.height === pdfCanvas.height) {
        const cacheDrawStartedAt = perf.begin();
        pdfContext.setTransform(1, 0, 0, 1, 0, 0);
        pdfContext.drawImage(cached.canvas, 0, 0);
        perf.time("Rendered page cache draw", cacheDrawStartedAt, `page ${pageNumber}`);
        pageRenders.delete(pageNumber);
        pageRenders.set(pageNumber, cached);
        renderedFromCache = true;
      } else {
        const pageRenderStartedAt = perf.begin();
        const renderViewport = page.getViewport({ scale: viewport.scale * pixelRatio });
        const renderTask = page.render({
          canvasContext: pdfContext,
          viewport: renderViewport
        });
        activeRender = renderTask;
        await renderTask.promise;
        if (activeRender === renderTask) activeRender = null;
        if (sequence !== renderSequence) return;
        cacheRenderedPage(pageNumber);
        perf.time("PDF canvas render", pageRenderStartedAt, `page ${pageNumber}`);
      }

      if (sequence !== renderSequence) return;
      inkContext.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
      await onPageChange(currentPdf.id, pageNumber);
      if (sequence !== renderSequence) return;
      if (firstPageRender) {
        openingDocument = false;
        perf.time("PDF first page + annotations visible", firstRenderStartedAt);
      }
      if (pageTurn) {
        perf.time(
          renderedFromCache ? "Page turn visible (cached)" : "Page turn visible (uncached)",
          pageTurn.startedAt,
          `page ${pageNumber}`
        );
      }
      saveLastPage(currentPdf.id, currentPage, pdfDocument.numPages).catch((error) => {
        setMessage(`Could not save your place: ${error.message}`);
      });
      reportMemory();
      schedulePreload(currentPage + 1);
    } catch (error) {
      if (openingDocument) openingDocument = false;
      if (error.name !== "RenderingCancelledException") {
        setMessage(`Could not render page: ${error.message}`);
      }
    }
  }

  function cacheRenderedPage(pageNumber) {
    const cachedCanvas = document.createElement("canvas");
    cachedCanvas.width = pdfCanvas.width;
    cachedCanvas.height = pdfCanvas.height;
    cachedCanvas.getContext("2d").drawImage(pdfCanvas, 0, 0);
    rememberPageRender(pageNumber, cachedCanvas);
  }

  function preloadPage(pageNumber, sequence) {
    if (!pdfDocument || sequence !== preloadSequence || pageNumber > pdfDocument.numPages) return;
    const preloadStartedAt = perf.begin();
    loadPage(pageNumber).then(async (page) => {
      if (
        !pdfDocument ||
        sequence !== preloadSequence ||
        pageNumber !== currentPage + 1 ||
        pageRenders.has(pageNumber)
      ) return;
      const viewport = calculateViewport(page);
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(Math.floor(viewport.width) * pixelRatio));
      canvas.height = Math.max(1, Math.round(Math.floor(viewport.height) * pixelRatio));
      preloadCanvas = canvas;
      const renderTask = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: page.getViewport({ scale: viewport.scale * pixelRatio })
      });
      preloadRenderTask = renderTask;
      await renderTask.promise;
      if (preloadRenderTask === renderTask) preloadRenderTask = null;
      if (pdfDocument && sequence === preloadSequence && pageNumber === currentPage + 1) {
        rememberPageRender(pageNumber, canvas);
        if (preloadCanvas === canvas) preloadCanvas = null;
        perf.time("Background page render", preloadStartedAt, `page ${pageNumber}`);
        reportMemory();
      } else {
        disposePageRender({ canvas });
      }
    }).catch((error) => {
      if (preloadRenderTask && sequence === preloadSequence) preloadRenderTask = null;
      if (preloadCanvas && sequence === preloadSequence) {
        disposePageRender({ canvas: preloadCanvas });
        preloadCanvas = null;
      }
      if (sequence === preloadSequence && error.name !== "RenderingCancelledException") {
        setMessage(`Could not prepare the next page: ${error.message}`);
      }
    });
  }

  async function open(pdfId) {
    const openStartedAt = perf.begin();
    await closeDocument();
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
      pageLoads = new Map();
      pageRenders = new Map();
      openingDocument = true;
      await renderPage(requestedPage);
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
    try {
      if (activeRender) activeRender.cancel();
    } catch (error) {
      console.error("Could not cancel the active PDF render:", error);
    }
    activeRender = null;
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
    pdfCanvas.width = 1;
    pdfCanvas.height = 1;
    inkCanvas.width = 1;
    inkCanvas.height = 1;
    updatePageLabel();
    reportMemory();
  }

  async function goToPage(pageNumber) {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) return;
    await renderPage(pageNumber, perf.enabled ? { startedAt: performance.now() } : null);
  }

  function navigate(delta) {
    if (!pdfDocument || isAnnotating()) return;
    const nextPage = currentPage + delta;
    if (nextPage < 1 || nextPage > pdfDocument.numPages) return;
    showToolbar();
    goToPage(nextPage);
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
        await saveLastPage(currentPdf.id, currentPage, pdfDocument.numPages);
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
  window.addEventListener("resize", () => {
    if (!pdfDocument) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      clearPageRenderCache();
      renderPage(currentPage);
    }, 100);
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

  return { open, setAnnotationMode, setPagePanelExpanded, hasDocument };
}
