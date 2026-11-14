import { getPdf, getSetting, saveLastPage } from "./db.js";

let pdfjsPromise;

function loadPdfJs() {
  if (!pdfjsPromise) {
    const pdfModuleUrl = new URL("./pdfjs/pdf.mjs", document.baseURI).href;
    pdfjsPromise = import(pdfModuleUrl).then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.mjs";
      return pdfjsLib;
    }).catch((error) => {
      pdfjsPromise = null;
      throw new Error(`PDF.js is unavailable. Add pdf.mjs and pdf.worker.mjs to ./pdfjs/. (${error.message})`);
    });
  }
  return pdfjsPromise;
}

export function createViewer({ onBack, isAnnotating = () => false, onPageChange = async () => {} }) {
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
  let hideTimer = null;
  let renderSequence = 0;
  let sliderDragging = false;
  let thumbnailObserver = null;
  let thumbnailRenderTask = null;
  let thumbnailRenderQueue = Promise.resolve();
  let thumbnailGeneration = 0;
  let thumbnailsInitialized = false;
  let thumbnailCache = new Map();
  let thumbnailButtons = new Map();
  let currentThumbnailButton = null;

  function setMessage(text) {
    readerMessage.textContent = text;
  }

  function updatePageLabel() {
    pageLabel.textContent = pdfDocument ? `${currentPage} / ${pdfDocument.numPages}` : "— / —";
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

  function openPagePanel() {
    if (!pdfDocument) return;
    pageJumpPanel.hidden = false;
    pageLabel.setAttribute("aria-expanded", "true");
    window.clearTimeout(hideTimer);
    toolbar.classList.remove("is-hidden");
    setPageJumpMessage("");
    updatePageJumpControls();
    ensurePageThumbnails();
  }

  function closePagePanel() {
    pageJumpPanel.hidden = true;
    pageLabel.setAttribute("aria-expanded", "false");
    sliderDragging = false;
    if (readerView.classList.contains("is-active")) showToolbar();
  }

  function togglePagePanel() {
    if (pageJumpPanel.hidden) openPagePanel();
    else closePagePanel();
  }

  function clearPageThumbnails() {
    thumbnailGeneration += 1;
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
      thumbnailObserver = null;
    }
    if (thumbnailRenderTask) {
      thumbnailRenderTask.cancel();
      thumbnailRenderTask = null;
    }
    thumbnailCache.clear();
    thumbnailButtons.clear();
    currentThumbnailButton = null;
    pageThumbnailGrid.replaceChildren();
    thumbnailsInitialized = false;
  }

  function queueThumbnail(pageNumber, canvas, generation) {
    thumbnailRenderQueue = thumbnailRenderQueue.then(async () => {
      if (
        generation !== thumbnailGeneration ||
        !pdfDocument ||
        !canvas.isConnected ||
        thumbnailCache.has(pageNumber)
      ) return;

      const page = await loadPage(pageNumber);
      if (generation !== thumbnailGeneration || !canvas.isConnected) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = 120 / baseViewport.width;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const task = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport
      });
      thumbnailRenderTask = task;
      try {
        await task.promise;
        if (generation === thumbnailGeneration && canvas.isConnected) {
          thumbnailCache.set(pageNumber, canvas);
        }
      } finally {
        if (thumbnailRenderTask === task) thumbnailRenderTask = null;
      }
    }).catch((error) => {
      if (generation === thumbnailGeneration && error.name !== "RenderingCancelledException") {
        setPageJumpMessage(`Could not render page ${pageNumber} thumbnail: ${error.message}`);
      }
    });
  }

  function ensurePageThumbnails() {
    if (!pdfDocument || thumbnailsInitialized) return;
    thumbnailsInitialized = true;
    const generation = thumbnailGeneration;
    const fragment = document.createDocumentFragment();
    const canvases = [];

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const button = document.createElement("button");
      button.className = "page-thumbnail";
      button.type = "button";
      button.setAttribute("aria-label", `Go to page ${pageNumber}`);
      button.dataset.pageNumber = String(pageNumber);
      button.addEventListener("click", () => jumpToPage(pageNumber));

      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 160;
      canvas.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "page-thumbnail-label";
      label.textContent = String(pageNumber);
      button.append(canvas, label);
      fragment.append(button);
      thumbnailButtons.set(pageNumber, button);
      canvases.push({ pageNumber, button, canvas });
    }

    pageThumbnailGrid.replaceChildren(fragment);
    updatePageJumpControls();
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const button = entry.target;
          const pageNumber = Number(button.dataset.pageNumber);
          const canvas = button.querySelector("canvas");
          observer.unobserve(button);
          queueThumbnail(pageNumber, canvas, generation);
        }
      }, {
        root: pageThumbnailGrid,
        rootMargin: "140px"
      });
      thumbnailObserver = observer;
      for (const item of canvases) thumbnailObserver.observe(item.button);
    } else {
      for (const item of canvases) {
        queueThumbnail(item.pageNumber, item.canvas, generation);
      }
    }
  }

  function jumpToPage(pageNumber, closePanel = false) {
    if (!pdfDocument || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdfDocument.numPages) {
      return;
    }
    if (closePanel) closePagePanel();
    showToolbar();
    goToPage(pageNumber);
  }

  function showToolbar() {
    toolbar.classList.remove("is-hidden");
    window.clearTimeout(hideTimer);
    if (isAnnotating() || !pageJumpPanel.hidden) return;
    hideTimer = window.setTimeout(() => toolbar.classList.add("is-hidden"), 3200);
  }

  function toggleToolbar() {
    if (isAnnotating()) return;
    if (toolbar.classList.contains("is-hidden")) {
      showToolbar();
    } else {
      window.clearTimeout(hideTimer);
      toolbar.classList.add("is-hidden");
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
    const verticalPadding = toolbar.classList.contains("is-hidden") ? 16 : 68;
    const availableWidth = Math.max(1, bounds.width - 12);
    const availableHeight = Math.max(1, bounds.height - verticalPadding);
    const scale = Math.min(availableHeight / baseViewport.height, availableWidth / baseViewport.width);
    return page.getViewport({ scale });
  }

  function loadPage(pageNumber) {
    if (!pageLoads.has(pageNumber)) {
      const pagePromise = pdfDocument.getPage(pageNumber);
      pageLoads.set(pageNumber, pagePromise);
      pagePromise.catch(() => pageLoads.delete(pageNumber));
    }
    return pageLoads.get(pageNumber);
  }

  async function renderPage(pageNumber) {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) return;
    const sequence = ++renderSequence;
    if (activeRender) {
      activeRender.cancel();
      activeRender = null;
    }

    currentPage = pageNumber;
    updatePageLabel();
    setMessage("");
    try {
      const page = await loadPage(pageNumber);
      if (sequence !== renderSequence) return;
      const viewport = calculateViewport(page);
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      resizeCanvas(pdfCanvas, width, height, pixelRatio);
      resizeCanvas(inkCanvas, width, height, pixelRatio);

      const cached = pageRenders.get(pageNumber);
      if (cached && cached.width === pdfCanvas.width && cached.height === pdfCanvas.height) {
        pdfContext.setTransform(1, 0, 0, 1, 0, 0);
        pdfContext.drawImage(cached.canvas, 0, 0);
      } else {
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
      }

      if (sequence !== renderSequence) return;
      inkContext.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
      await onPageChange(currentPdf.id, pageNumber);
      if (sequence !== renderSequence) return;
      saveLastPage(currentPdf.id, currentPage, pdfDocument.numPages).catch((error) => {
        setMessage(`Could not save your place: ${error.message}`);
      });
      preloadPage(currentPage + 1);
    } catch (error) {
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
    pageRenders.set(pageNumber, {
      canvas: cachedCanvas,
      width: cachedCanvas.width,
      height: cachedCanvas.height
    });
    while (pageRenders.size > 3) {
      const oldest = pageRenders.keys().next().value;
      pageRenders.delete(oldest);
    }
  }

  function preloadPage(pageNumber) {
    if (!pdfDocument || pageNumber > pdfDocument.numPages) return;
    // Keep the following page ready at the current display size for faster turns.
    loadPage(pageNumber).then(async (page) => {
      if (!pdfDocument || pageNumber <= currentPage || pageRenders.has(pageNumber)) return;
      const viewport = calculateViewport(page);
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(Math.floor(viewport.width) * pixelRatio));
      canvas.height = Math.max(1, Math.round(Math.floor(viewport.height) * pixelRatio));
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport: page.getViewport({ scale: viewport.scale * pixelRatio })
      }).promise;
      if (pdfDocument && pageNumber > currentPage) {
        pageRenders.set(pageNumber, {
          canvas,
          width: canvas.width,
          height: canvas.height
        });
      }
    }).catch((error) => {
      if (error.name !== "RenderingCancelledException") {
        setMessage(`Could not prepare the next page: ${error.message}`);
      }
    });
  }

  async function open(pdfId) {
    await closeDocument();
    readerView.classList.add("is-active");
    readerView.setAttribute("aria-hidden", "false");
    setMessage("Opening PDF…");
    try {
      let record;
      try {
        record = await getPdf(pdfId);
      } catch (error) {
        throw new Error(`Could not read PDF from storage: ${error.message}`);
      }
      if (!record) throw new Error("This PDF is no longer in the library.");
      if ("blob" in record) {
        throw new Error("This PDF uses the old storage format. Please delete it and re-import it from the Files app.");
      }
      if (!(record.data instanceof ArrayBuffer)) {
        throw new Error("The stored PDF data is missing or invalid. Please re-import this PDF from the Files app.");
      }

      currentPdf = record;
      const pdfjsLib = await loadPdfJs();
      const data = new Uint8Array(record.data.slice(0));
      loadingTask = pdfjsLib.getDocument({ data });
      pdfDocument = await loadingTask.promise;
      currentPdf.pageCount = pdfDocument.numPages;
      titleElement.textContent = currentPdf.name;
      const requestedPage = Math.min(Math.max(1, currentPdf.lastPage || 1), pdfDocument.numPages);
      pageLoads = new Map();
      pageRenders = new Map();
      showToolbar();
      await renderPage(requestedPage);
    } catch (error) {
      setMessage(`Could not open PDF: ${error.message}`);
    }
  }

  async function closeDocument() {
    renderSequence += 1;
    window.clearTimeout(hideTimer);
    hideTimer = null;
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
    pageRenders.clear();
    currentPdf = null;
    currentPage = 1;
    pdfCanvas.width = 1;
    pdfCanvas.height = 1;
    inkCanvas.width = 1;
    inkCanvas.height = 1;
    updatePageLabel();
  }

  async function goToPage(pageNumber) {
    if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages) return;
    await renderPage(pageNumber);
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
    if (!target.closest("#readerToolbar, #metronomePanel, #annotationToolbar")) {
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
      pageRenders.clear();
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
    if (active) {
      window.clearTimeout(hideTimer);
      toolbar.classList.remove("is-hidden");
    } else {
      showToolbar();
    }
  }

  return { open, setAnnotationMode };
}
