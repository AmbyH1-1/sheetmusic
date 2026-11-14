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

export function createViewer({ onBack }) {
  const readerView = document.querySelector("#readerView");
  const pageContainer = document.querySelector("#pageContainer");
  const pdfCanvas = document.querySelector("#pdfCanvas");
  const inkCanvas = document.querySelector("#inkCanvas");
  const pdfContext = pdfCanvas.getContext("2d", { alpha: false });
  const inkContext = inkCanvas.getContext("2d");
  const toolbar = document.querySelector("#readerToolbar");
  const titleElement = document.querySelector("#readerTitle");
  const pageLabel = document.querySelector("#pageLabel");
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

  function setMessage(text) {
    readerMessage.textContent = text;
  }

  function updatePageLabel() {
    pageLabel.textContent = pdfDocument ? `${currentPage} / ${pdfDocument.numPages}` : "— / —";
    document.querySelector("#previousButton").disabled = !pdfDocument || currentPage <= 1;
    document.querySelector("#nextButton").disabled = !pdfDocument || currentPage >= pdfDocument.numPages;
  }

  function showToolbar() {
    toolbar.classList.remove("is-hidden");
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => toolbar.classList.add("is-hidden"), 3200);
  }

  function toggleToolbar() {
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

      inkContext.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
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
    readerView.hidden = false;
    setMessage("Opening PDF…");
    try {
      const record = await getPdf(pdfId);
      if (!record) throw new Error("This PDF is no longer in the library.");
      if (!record.blob || typeof record.blob.arrayBuffer !== "function") {
        throw new Error("The stored PDF data is missing or invalid.");
      }

      currentPdf = record;
      const pdfjsLib = await loadPdfJs();
      const data = new Uint8Array(await record.blob.arrayBuffer());
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
    if (!pdfDocument) return;
    const nextPage = currentPage + delta;
    if (nextPage < 1 || nextPage > pdfDocument.numPages) return;
    showToolbar();
    goToPage(nextPage);
  }

  function handleTapZone(event) {
    if (!pdfDocument) return;
    const x = event.clientX / window.innerWidth;
    if (x < zoneFraction) {
      navigate(-1);
    } else if (x > 1 - zoneFraction) {
      navigate(1);
    } else {
      showToolbar();
    }
  }

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
      readerView.hidden = true;
      await onBack();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (readerView.hidden) return;
    if (event.key === "ArrowLeft") navigate(-1);
    if (event.key === "ArrowRight") navigate(1);
    if (event.key === "Escape") document.querySelector("#backButton").click();
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

  return { open };
}
