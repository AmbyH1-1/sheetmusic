const DB_NAME = "sheetmusic-library";
const DB_VERSION = 1;

let databasePromise;

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

export async function addPdf(blob, name) {
  const db = await openDatabase();
  const pdf = {
    id: makeId(),
    name,
    blob,
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
