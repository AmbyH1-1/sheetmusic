const DB_NAME = "sheetmusic-library";
const DB_VERSION = 1;
const BACKUP_FORMAT_VERSION = 1;
const BASE64_CHUNK_SIZE = 0x6000;

let databasePromise;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reportProgress(callback, progress) {
  if (typeof callback === "function") callback(progress);
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function hasPdfHeader(data) {
  const header = new Uint8Array(data, 0, Math.min(data.byteLength, 1024));
  let text = "";
  for (const byte of header) text += String.fromCharCode(byte);
  return text.includes("%PDF-");
}

async function encodeBase64(data, onChunk) {
  const bytes = new Uint8Array(data);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + BASE64_CHUNK_SIZE, bytes.length));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    chunks.push(btoa(binary));
    onChunk(chunk.length);
    await yieldToBrowser();
  }
  return chunks.join("");
}

async function decodeBase64(value, onChunk) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("A PDF in this backup has invalid base64 data.");
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let byteOffset = 0;
  for (let offset = 0; offset < value.length; offset += BASE64_CHUNK_SIZE) {
    let decoded;
    try {
      decoded = atob(value.slice(offset, offset + BASE64_CHUNK_SIZE));
    } catch (error) {
      throw new Error(`A PDF in this backup could not be decoded: ${error.message}`);
    }
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[byteOffset] = decoded.charCodeAt(index);
      byteOffset += 1;
    }
    onChunk(decoded.length);
    await yieldToBrowser();
  }
  return bytes.buffer;
}

function validateStroke(stroke) {
  if (
    !isRecord(stroke) ||
    !["pen", "highlighter"].includes(stroke.tool) ||
    typeof stroke.color !== "string" ||
    !Number.isFinite(stroke.width) ||
    stroke.width <= 0 ||
    (stroke.opacity !== undefined &&
      (!Number.isFinite(stroke.opacity) || stroke.opacity < 0 || stroke.opacity > 1)) ||
    !Array.isArray(stroke.points)
  ) {
    throw new Error("An annotation in this backup has an invalid stroke.");
  }
  for (const point of stroke.points) {
    if (
      !isRecord(point) ||
      !Number.isFinite(point.x) ||
      point.x < 0 ||
      point.x > 1 ||
      !Number.isFinite(point.y) ||
      point.y < 0 ||
      point.y > 1 ||
      !Number.isFinite(point.pressure) ||
      point.pressure < 0 ||
      point.pressure > 1
    ) {
      throw new Error("An annotation in this backup has an invalid point.");
    }
  }
}

function prepareBackup(backup) {
  if (!isRecord(backup) || backup.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format. Expected version ${BACKUP_FORMAT_VERSION}.`);
  }
  if (
    typeof backup.exportedAt !== "string" ||
    Number.isNaN(Date.parse(backup.exportedAt)) ||
    !Array.isArray(backup.pdfs) ||
    !isRecord(backup.annotations) ||
    !Array.isArray(backup.settings)
  ) {
    throw new Error("This backup is missing required data or has an invalid structure.");
  }

  const pdfIds = new Set();
  const pageCounts = new Map();
  for (const pdf of backup.pdfs) {
    if (
      !isRecord(pdf) ||
      typeof pdf.id !== "string" ||
      !pdf.id ||
      pdfIds.has(pdf.id) ||
      typeof pdf.name !== "string" ||
      !pdf.name.trim() ||
      typeof pdf.data !== "string" ||
      !Number.isInteger(pdf.lastPage) ||
      pdf.lastPage < 1 ||
      (pdf.pageCount !== null &&
        (!Number.isInteger(pdf.pageCount) || pdf.pageCount < 1 || pdf.lastPage > pdf.pageCount)) ||
      (pdf.addedAt !== undefined && !Number.isFinite(pdf.addedAt)) ||
      (pdf.lastOpenedAt !== null &&
        pdf.lastOpenedAt !== undefined &&
        !Number.isFinite(pdf.lastOpenedAt))
    ) {
      throw new Error("A PDF entry in this backup is invalid or duplicated.");
    }
    pdfIds.add(pdf.id);
    pageCounts.set(pdf.id, pdf.pageCount);
  }

  const annotationRows = [];
  for (const pdfId of Object.keys(backup.annotations)) {
    const pages = backup.annotations[pdfId];
    if (!pdfIds.has(pdfId) || !isRecord(pages)) {
      throw new Error("The backup contains annotations for an unknown PDF.");
    }
    for (const pageText of Object.keys(pages)) {
      const pageNumber = Number(pageText);
      const strokes = pages[pageText];
      const pageCount = pageCounts.get(pdfId);
      if (
        !/^[1-9]\d*$/.test(pageText) ||
        !Number.isSafeInteger(pageNumber) ||
        (pageCount !== null && pageNumber > pageCount) ||
        !Array.isArray(strokes)
      ) {
        throw new Error("The backup contains an invalid annotation page.");
      }
      for (const stroke of strokes) validateStroke(stroke);
      annotationRows.push({
        key: `${pdfId}:${pageNumber}`,
        pdfId,
        pageNumber,
        strokes
      });
    }
  }

  const settings = [];
  const settingKeys = new Set();
  for (const setting of backup.settings) {
    if (
      !isRecord(setting) ||
      typeof setting.key !== "string" ||
      !setting.key ||
      settingKeys.has(setting.key) ||
      !Object.prototype.hasOwnProperty.call(setting, "value")
    ) {
      throw new Error("A setting in this backup is invalid or duplicated.");
    }
    settingKeys.add(setting.key);
    settings.push(setting);
  }

  return { annotationRows, settings };
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("pdfs")) {
        db.createObjectStore("pdfs", { keyPath: "id" });
      }
      // Keep ink and settings separate so the source PDF is never rewritten.
      if (!db.objectStoreNames.contains("annotations")) {
        const annotations = db.createObjectStore("annotations", { keyPath: "key" });
        annotations.createIndex("pdfId", "pdfId", { unique: false });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("Could not open the music library."));
    request.onblocked = () => reject(new Error("The music library is blocked by another open tab."));
  });

  databasePromise.catch(() => {
    databasePromise = undefined;
  });
  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("The database request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("The database transaction was aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("The database transaction failed."));
  });
}

function makeId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function addPdf(data, name) {
  if (!(data instanceof ArrayBuffer)) {
    throw new TypeError("PDF data must be an ArrayBuffer.");
  }
  const db = await openDatabase();
  const pdf = {
    id: makeId(),
    name,
    data,
    addedAt: Date.now(),
    lastOpenedAt: null,
    lastPage: 1,
    pageCount: null
  };
  const tx = db.transaction("pdfs", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("pdfs").add(pdf);
  await done;
  return pdf;
}

export async function listPdfs() {
  const db = await openDatabase();
  const tx = db.transaction("pdfs", "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore("pdfs").getAll());
  await done;
  return result.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getPdf(id) {
  const db = await openDatabase();
  const tx = db.transaction("pdfs", "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore("pdfs").get(id));
  await done;
  return result;
}

export async function deletePdf(id) {
  const db = await openDatabase();
  const tx = db.transaction(["pdfs", "annotations"], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("pdfs").delete(id);
  const index = tx.objectStore("annotations").index("pdfId");
  const cursorRequest = index.openCursor(IDBKeyRange.only(id));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await done;
}

export async function renamePdf(id, name) {
  const db = await openDatabase();
  const tx = db.transaction("pdfs", "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore("pdfs");
  const request = store.get(id);
  let missingPdf = false;
  request.onsuccess = () => {
    const pdf = request.result;
    if (!pdf) {
      missingPdf = true;
      tx.abort();
      return;
    }
    pdf.name = name;
    store.put(pdf);
  };
  request.onerror = () => tx.abort();
  try {
    await done;
  } catch (error) {
    if (missingPdf) {
      throw new Error("That PDF is no longer in the library.");
    }
    throw error;
  }
  return request.result;
}

export async function saveLastPage(id, page, pageCount) {
  const db = await openDatabase();
  const tx = db.transaction("pdfs", "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore("pdfs");
  const request = store.get(id);
  let missingPdf = false;
  request.onsuccess = () => {
    const pdf = request.result;
    if (!pdf) {
      missingPdf = true;
      tx.abort();
      return;
    }
    pdf.lastPage = page;
    pdf.pageCount = pageCount;
    pdf.lastOpenedAt = Date.now();
    store.put(pdf);
  };
  request.onerror = () => tx.abort();
  try {
    await done;
  } catch (error) {
    if (missingPdf) {
      throw new Error("That PDF is no longer in the library.");
    }
    throw error;
  }
}

export async function saveAnnotations(pdfId, pageNumber, strokes) {
  const db = await openDatabase();
  const tx = db.transaction("annotations", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("annotations").put({
    key: `${pdfId}:${pageNumber}`,
    pdfId,
    pageNumber,
    strokes
  });
  await done;
}

export async function loadAnnotations(pdfId, pageNumber) {
  const db = await openDatabase();
  const tx = db.transaction("annotations", "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(
    tx.objectStore("annotations").get(`${pdfId}:${pageNumber}`)
  );
  await done;
  return result ? result.strokes : [];
}

export async function getSetting(key, fallbackValue = null) {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore("settings").get(key));
  await done;
  return result ? result.value : fallbackValue;
}

export async function setSetting(key, value) {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("settings").put({ key, value });
  await done;
}

export async function initializeDatabase() {
  await openDatabase();
}

export async function exportBackup(onProgress) {
  const db = await openDatabase();
  const tx = db.transaction(["pdfs", "annotations", "settings"], "readonly");
  const done = transactionDone(tx);
  const [pdfs, annotations, settings] = await Promise.all([
    requestResult(tx.objectStore("pdfs").getAll()),
    requestResult(tx.objectStore("annotations").getAll()),
    requestResult(tx.objectStore("settings").getAll())
  ]);
  await done;

  const totalBytes = pdfs.reduce((total, pdf) => {
    if (!(pdf.data instanceof ArrayBuffer)) {
      throw new Error(`"${pdf.name}" uses an unsupported PDF storage format. Re-import it before backing up.`);
    }
    return total + pdf.data.byteLength;
  }, 0);
  let completedBytes = 0;
  const backupPdfs = [];
  for (const pdf of pdfs) {
    if (!hasPdfHeader(pdf.data)) {
      throw new Error(`"${pdf.name}" does not contain valid PDF data.`);
    }
    const data = await encodeBase64(pdf.data, (chunkBytes) => {
      reportProgress(onProgress, {
        phase: "encoding",
        completedBytes: completedBytes + chunkBytes,
        totalBytes
      });
      completedBytes += chunkBytes;
    });
    backupPdfs.push({
      id: pdf.id,
      name: pdf.name,
      data,
      addedAt: pdf.addedAt,
      lastOpenedAt: pdf.lastOpenedAt ?? null,
      lastPage: pdf.lastPage,
      pageCount: pdf.pageCount ?? null
    });
  }

  const backupAnnotations = Object.create(null);
  for (const annotation of annotations) {
    if (!backupAnnotations[annotation.pdfId]) {
      backupAnnotations[annotation.pdfId] = Object.create(null);
    }
    backupAnnotations[annotation.pdfId][String(annotation.pageNumber)] = annotation.strokes;
  }

  reportProgress(onProgress, {
    phase: "packaging",
    completedBytes: totalBytes,
    totalBytes
  });
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    pdfs: backupPdfs,
    annotations: backupAnnotations,
    settings: settings.map(({ key, value }) => ({ key, value }))
  };
}

export async function importBackup(backup, mode = "merge", onProgress) {
  if (!["merge", "replace"].includes(mode)) {
    throw new Error("Choose either Merge or Replace all when restoring a backup.");
  }
  const { annotationRows, settings } = prepareBackup(backup);
  const totalBytes = backup.pdfs.reduce((total, pdf) => total + Math.floor((pdf.data.length * 3) / 4), 0);
  let completedBytes = 0;
  const pdfs = [];

  for (const pdf of backup.pdfs) {
    let pdfBytes = 0;
    const data = await decodeBase64(pdf.data, (chunkBytes) => {
      pdfBytes += chunkBytes;
      reportProgress(onProgress, {
        phase: "decoding",
        completedBytes: completedBytes + pdfBytes,
        totalBytes
      });
    });
    if (!hasPdfHeader(data)) {
      throw new Error(`"${pdf.name}" does not contain valid PDF data.`);
    }
    completedBytes += data.byteLength;
    pdfs.push({
      id: pdf.id,
      name: pdf.name,
      data,
      addedAt: pdf.addedAt ?? Date.now(),
      lastOpenedAt: pdf.lastOpenedAt ?? null,
      lastPage: pdf.lastPage,
      pageCount: pdf.pageCount
    });
  }

  const db = await openDatabase();
  let pdfsToWrite = pdfs;
  let annotationsToWrite = annotationRows;
  let settingsToWrite = settings;

  if (mode === "merge") {
    const readTx = db.transaction(["pdfs", "annotations", "settings"], "readonly");
    const readDone = transactionDone(readTx);
    const [existingPdfs, existingAnnotations, existingSettings] = await Promise.all([
      requestResult(readTx.objectStore("pdfs").getAll()),
      requestResult(readTx.objectStore("annotations").getAll()),
      requestResult(readTx.objectStore("settings").getAll())
    ]);
    await readDone;

    const existingPdfIds = new Set(existingPdfs.map((pdf) => pdf.id));
    const existingAnnotationKeys = new Set(existingAnnotations.map((annotation) => annotation.key));
    const existingSettingKeys = new Set(existingSettings.map((setting) => setting.key));
    pdfsToWrite = pdfs.filter((pdf) => !existingPdfIds.has(pdf.id));
    annotationsToWrite = annotationRows.filter((annotation) => !existingAnnotationKeys.has(annotation.key));
    settingsToWrite = settings.filter((setting) => !existingSettingKeys.has(setting.key));
  }

  const tx = db.transaction(["pdfs", "annotations", "settings"], "readwrite");
  const done = transactionDone(tx);
  const pdfStore = tx.objectStore("pdfs");
  const annotationStore = tx.objectStore("annotations");
  const settingStore = tx.objectStore("settings");
  if (mode === "replace") {
    pdfStore.clear();
    annotationStore.clear();
    settingStore.clear();
  }
  for (const pdf of pdfsToWrite) pdfStore.put(pdf);
  for (const annotation of annotationsToWrite) annotationStore.put(annotation);
  for (const setting of settingsToWrite) settingStore.put(setting);
  reportProgress(onProgress, {
    phase: "saving",
    completedBytes: totalBytes,
    totalBytes
  });
  await done;

  return {
    mode,
    pdfCount: pdfsToWrite.length,
    annotationCount: annotationsToWrite.length,
    settingCount: settingsToWrite.length
  };
}
