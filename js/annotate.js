import { getSetting, loadAnnotations, saveAnnotations, setSetting } from "./db.js";

const SAVE_DELAY_MS = 350;

export function createAnnotator({ onModeChange = () => {} } = {}) {
  const readerView = document.querySelector("#readerView");
  const canvas = document.querySelector("#inkCanvas");
  const context = canvas.getContext("2d");
  const toggleButton = document.querySelector("#annotationToggle");
  const toolbar = document.querySelector("#annotationToolbar");
  const message = document.querySelector("#annotationMessage");
  const widthInput = document.querySelector("#annotationWidth");
  const widthValue = document.querySelector("#annotationWidthValue");
  const undoButton = document.querySelector("#annotationUndo");
  const redoButton = document.querySelector("#annotationRedo");
  const fingerInput = document.querySelector("#allowFingerDrawing");
  const toolButtons = Array.from(document.querySelectorAll("[data-annotation-tool]"));
  const colorButtons = Array.from(document.querySelectorAll("[data-ink-color]"));

  let active = false;
  let activePdfId = null;
  let activePageNumber = null;
  let loadSequence = 0;
  let currentTool = "pen";
  let currentColor = "#17191f";
  let thickness = Number(widthInput.value);
  let allowFingerDrawing = false;
  let strokes = [];
  let undoStack = [];
  let redoStack = [];
  let currentStroke = null;
  let currentErasures = null;
  let activePointerId = null;
  let saveTimer = null;
  let pendingSave = null;
  let saveQueue = Promise.resolve();

  function setMessage(text) {
    message.textContent = text;
  }

  function updateHistoryButtons() {
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
  }

  function cloneStrokes(items) {
    return items.map((stroke) => ({
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map((point) => ({
        x: point.x,
        y: point.y,
        pressure: point.pressure
      }))
    }));
  }

  function createSaveSnapshot() {
    if (!activePdfId || !activePageNumber) return null;
    return {
      pdfId: activePdfId,
      pageNumber: activePageNumber,
      strokes: cloneStrokes(strokes)
    };
  }

  function persistSnapshot(snapshot) {
    saveQueue = saveQueue.catch(() => {}).then(() => (
      saveAnnotations(snapshot.pdfId, snapshot.pageNumber, snapshot.strokes)
    ));
    saveQueue.catch((error) => {
      setMessage(`Could not save annotations: ${error.message}`);
    });
    return saveQueue;
  }

  function scheduleSave() {
    const snapshot = createSaveSnapshot();
    if (!snapshot) return;
    pendingSave = snapshot;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const save = pendingSave;
      pendingSave = null;
      saveTimer = null;
      if (save) persistSnapshot(save);
    }, SAVE_DELAY_MS);
  }

  async function flushSave() {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      const save = pendingSave;
      pendingSave = null;
      if (save) await persistSnapshot(save);
    }
    await saveQueue;
  }

  function getCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { rect, width: rect.width, height: rect.height };
  }

  function prepareStroke(stroke, size) {
    context.setTransform(
      canvas.width / size.width,
      0,
      0,
      canvas.height / size.height,
      0,
      0
    );
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = stroke.tool === "highlighter" ? 0.34 : 1;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineCap = "round";
    context.lineJoin = "round";
  }

  function drawSegment(stroke, from, to) {
    const size = getCanvasSize();
    if (!size) return;
    prepareStroke(stroke, size);
    const pressure = Math.max(0.1, (from.pressure + to.pressure) / 2);
    context.lineWidth = Math.max(0.5, stroke.width * size.width * pressure);
    context.beginPath();
    context.moveTo(from.x * size.width, from.y * size.height);
    context.lineTo(to.x * size.width, to.y * size.height);
    context.stroke();
  }

  function drawDot(stroke, point) {
    const size = getCanvasSize();
    if (!size) return;
    prepareStroke(stroke, size);
    const radius = Math.max(0.5, stroke.width * size.width * point.pressure / 2);
    context.beginPath();
    context.arc(point.x * size.width, point.y * size.height, radius, 0, Math.PI * 2);
    context.fill();
  }

  function drawStroke(stroke) {
    if (!stroke.points.length) return;
    if (stroke.points.length === 1) {
      drawDot(stroke, stroke.points[0]);
      return;
    }
    for (let index = 1; index < stroke.points.length; index += 1) {
      drawSegment(stroke, stroke.points[index - 1], stroke.points[index]);
    }
  }

  function redraw() {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) {
      if (!currentErasures || !currentErasures.has(stroke)) drawStroke(stroke);
    }
  }

  function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const projection = lengthSquared
      ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
      : 0;
    return Math.hypot(px - (ax + projection * dx), py - (ay + projection * dy));
  }

  function strokeIsTouched(stroke, point, size, eraserRadius) {
    const px = point.x * size.width;
    const py = point.y * size.height;
    const strokeRadius = stroke.width * size.width / 2;
    const threshold = eraserRadius + strokeRadius;
    if (stroke.points.length === 1) {
      const onlyPoint = stroke.points[0];
      return Math.hypot(px - onlyPoint.x * size.width, py - onlyPoint.y * size.height) <= threshold;
    }
    for (let index = 1; index < stroke.points.length; index += 1) {
      const from = stroke.points[index - 1];
      const to = stroke.points[index];
      const distance = distanceToSegment(
        px,
        py,
        from.x * size.width,
        from.y * size.height,
        to.x * size.width,
        to.y * size.height
      );
      if (distance <= threshold) return true;
    }
    return false;
  }

  function eraseAt(point) {
    const size = getCanvasSize();
    if (!size || !currentErasures) return;
    const radius = currentStroke.width * size.width / 2;
    let changed = false;
    for (const stroke of strokes) {
      if (!currentErasures.has(stroke) && strokeIsTouched(stroke, point, size, radius)) {
        currentErasures.add(stroke);
        changed = true;
      }
    }
    if (changed) redraw();
  }

  function makePoint(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const pressure = Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : 0.5;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      pressure: Math.min(1, pressure)
    };
  }

  function appendPoint(event) {
    if (!currentStroke) return;
    const point = makePoint(event);
    if (!point) return;
    const previous = currentStroke.points[currentStroke.points.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) return;
    currentStroke.points.push(point);
    if (currentStroke.tool === "eraser") {
      eraseAt(point);
    } else if (previous) {
      drawSegment(currentStroke, previous, point);
    } else {
      drawDot(currentStroke, point);
    }
  }

  function appendPointerSamples(event) {
    const samples = typeof event.getCoalescedEvents === "function"
      ? Array.from(event.getCoalescedEvents())
      : [];
    const lastSample = samples[samples.length - 1];
    if (!lastSample || lastSample.clientX !== event.clientX || lastSample.clientY !== event.clientY) {
      samples.push(event);
    }
    for (const sample of samples) appendPoint(sample);
  }

  function finishStroke() {
    if (!currentStroke) {
      activePointerId = null;
      return;
    }
    if (currentStroke.tool === "eraser") {
      const removed = [];
      strokes.forEach((stroke, index) => {
        if (currentErasures.has(stroke)) removed.push({ stroke, index });
      });
      if (removed.length) {
        strokes = strokes.filter((stroke) => !currentErasures.has(stroke));
        undoStack.push({ type: "erase", removed });
        redoStack = [];
        redraw();
        scheduleSave();
      }
    } else {
      undoStack.push({ type: "add", stroke: currentStroke });
      redoStack = [];
      scheduleSave();
    }
    currentStroke = null;
    currentErasures = null;
    activePointerId = null;
    updateHistoryButtons();
  }

  function isDrawingPointer(event) {
    if (event.pointerType === "pen" || event.pointerType === "mouse") return true;
    return event.pointerType === "touch" && allowFingerDrawing;
  }

  function handlePointerDown(event) {
    if (!active || activePointerId !== null || !isDrawingPointer(event)) return;
    event.preventDefault();
    const size = getCanvasSize();
    if (!size) return;
    activePointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    const widthFactor = currentTool === "highlighter" ? 2.5 : currentTool === "eraser" ? 3 : 1;
    currentStroke = {
      tool: currentTool,
      color: currentColor,
      width: (thickness * widthFactor) / size.width,
      points: []
    };
    if (currentTool === "eraser") currentErasures = new Set();
    else strokes.push(currentStroke);
    appendPointerSamples(event);
  }

  function handlePointerMove(event) {
    if (!active || event.pointerId !== activePointerId) return;
    event.preventDefault();
    appendPointerSamples(event);
  }

  function handlePointerEnd(event) {
    if (event.pointerId !== activePointerId) return;
    event.preventDefault();
    appendPointerSamples(event);
    finishStroke();
  }

  function selectTool(tool) {
    currentTool = tool;
    for (const button of toolButtons) {
      const selected = button.dataset.annotationTool === tool;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function selectColor(color) {
    currentColor = color;
    for (const button of colorButtons) {
      const selected = button.dataset.inkColor === color;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function undo() {
    finishStroke();
    const action = undoStack.pop();
    if (!action) return;
    if (action.type === "add") {
      const index = strokes.lastIndexOf(action.stroke);
      if (index !== -1) strokes.splice(index, 1);
    } else if (action.type === "erase") {
      for (const item of action.removed) {
        strokes.splice(Math.min(item.index, strokes.length), 0, item.stroke);
      }
    } else if (action.type === "clear") {
      strokes = action.strokes.slice();
    }
    redoStack.push(action);
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function redo() {
    finishStroke();
    const action = redoStack.pop();
    if (!action) return;
    if (action.type === "add") {
      strokes.push(action.stroke);
    } else if (action.type === "erase") {
      const erased = new Set(action.removed.map((item) => item.stroke));
      strokes = strokes.filter((stroke) => !erased.has(stroke));
    } else if (action.type === "clear") {
      strokes = [];
    }
    undoStack.push(action);
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function clearPage() {
    finishStroke();
    if (!strokes.length) return;
    if (!window.confirm("Clear all annotations on this page?")) return;
    undoStack.push({ type: "clear", strokes: strokes.slice() });
    redoStack = [];
    strokes = [];
    redraw();
    updateHistoryButtons();
    scheduleSave();
  }

  function setActive(nextActive) {
    if (active === nextActive) return;
    if (!nextActive) finishStroke();
    active = nextActive;
    readerView.classList.toggle("is-annotating", active);
    toolbar.hidden = !active;
    toggleButton.setAttribute("aria-pressed", String(active));
    toggleButton.textContent = active ? "Done" : "Annotate";
    onModeChange(active);
    if (!active) setMessage("");
  }

  async function setPage(pdfId, pageNumber) {
    finishStroke();
    const request = ++loadSequence;
    if (pdfId === activePdfId && pageNumber === activePageNumber) {
      redraw();
      return;
    }

    try {
      await flushSave();
    } catch (error) {
      setMessage(`Could not save annotations before changing pages: ${error.message}`);
    }
    if (request !== loadSequence) return;
    activePdfId = pdfId;
    activePageNumber = pageNumber;
    strokes = [];
    undoStack = [];
    redoStack = [];
    redraw();
    updateHistoryButtons();

    try {
      const savedStrokes = await loadAnnotations(pdfId, pageNumber);
      if (request !== loadSequence) return;
      strokes = Array.isArray(savedStrokes) ? savedStrokes : [];
      redraw();
      setMessage("");
    } catch (error) {
      if (request === loadSequence) {
        setMessage(`Could not load annotations: ${error.message}`);
      }
    }
  }

  async function exitMode() {
    setActive(false);
    finishStroke();
    try {
      await flushSave();
    } catch (error) {
      setMessage(`Could not save annotations: ${error.message}`);
    }
  }

  toggleButton.addEventListener("click", () => {
    if (active) exitMode();
    else setActive(true);
  });
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerEnd);
  canvas.addEventListener("pointercancel", handlePointerEnd);

  for (const button of toolButtons) {
    button.addEventListener("click", () => selectTool(button.dataset.annotationTool));
  }
  for (const button of colorButtons) {
    button.addEventListener("click", () => selectColor(button.dataset.inkColor));
  }

  widthInput.addEventListener("input", () => {
    thickness = Number(widthInput.value);
    widthValue.value = `${thickness} px`;
    widthValue.textContent = `${thickness} px`;
  });
  undoButton.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);
  document.querySelector("#annotationClear").addEventListener("click", clearPage);
  fingerInput.addEventListener("change", () => {
    allowFingerDrawing = fingerInput.checked;
    setSetting("allowFingerDrawing", allowFingerDrawing).catch((error) => {
      setMessage(`Could not save finger drawing setting: ${error.message}`);
    });
  });

  getSetting("allowFingerDrawing", false).then((saved) => {
    allowFingerDrawing = saved === true;
    fingerInput.checked = allowFingerDrawing;
  }).catch((error) => {
    setMessage(`Could not load finger drawing setting: ${error.message}`);
  });

  window.addEventListener("resize", redraw);
  updateHistoryButtons();

  return {
    exitMode,
    isActive: () => active,
    setPage
  };
}
