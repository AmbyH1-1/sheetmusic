import {
  addPdf,
  deletePdf,
  exportBackup,
  importBackup,
  listPdfs,
  renamePdf
} from "./db.js";

export function createLibrary({ onOpen }) {
  const importButton = document.querySelector("#importButton");
  const fileInput = document.querySelector("#fileInput");
  const pdfList = document.querySelector("#pdfList");
  const emptyLibrary = document.querySelector("#emptyLibrary");
  const message = document.querySelector("#libraryMessage");
  const exportBackupButton = document.querySelector("#exportBackupButton");
  const importBackupButton = document.querySelector("#importBackupButton");
  const backupFileInput = document.querySelector("#backupFileInput");
  const backupProgress = document.querySelector("#backupProgress");
  const backupMessage = document.querySelector("#backupMessage");
  const backupModePanel = document.querySelector("#backupModePanel");
  const mergeBackupButton = document.querySelector("#mergeBackupButton");
  const replaceBackupButton = document.querySelector("#replaceBackupButton");
  const cancelBackupButton = document.querySelector("#cancelBackupButton");
  let pendingBackup = null;
  let backupBusy = false;

  function showMessage(text) {
    message.textContent = text;
  }

  function showBackupMessage(text) {
    backupMessage.textContent = text;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function setBackupBusy(busy) {
    backupBusy = busy;
    exportBackupButton.disabled = busy;
    importBackupButton.disabled = busy;
    mergeBackupButton.disabled = busy;
    replaceBackupButton.disabled = busy;
    cancelBackupButton.disabled = busy;
  }

  function updateBackupProgress(progress) {
    const total = Math.max(1, progress.totalBytes);
    backupProgress.max = total;
    backupProgress.value = Math.min(total, progress.completedBytes);
    backupProgress.hidden = false;
    if (progress.phase === "encoding") showBackupMessage("Encoding PDF data for backup…");
    else if (progress.phase === "decoding") showBackupMessage("Restoring PDF data…");
    else if (progress.phase === "saving") showBackupMessage("Saving restored data…");
    else showBackupMessage("Preparing backup file…");
  }

  function downloadBackup(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function shareOrDownloadBackup(file) {
    let canShareFiles = typeof navigator.share === "function";
    if (canShareFiles && typeof navigator.canShare === "function") {
      try {
        canShareFiles = navigator.canShare({ files: [file] });
      } catch {
        canShareFiles = false;
      }
    }

    if (canShareFiles) {
      try {
        await navigator.share({ files: [file], title: "Sheet Music backup" });
        showBackupMessage("Backup ready to save or share.");
        return;
      } catch (error) {
        if (error.name === "AbortError") {
          showBackupMessage("Backup sharing was canceled.");
          return;
        }
        showBackupMessage(`Sharing failed; downloading instead: ${error.message}`);
      }
    }
    downloadBackup(file);
    showBackupMessage("Backup downloaded.");
  }

  async function restorePendingBackup(mode) {
    if (!pendingBackup || backupBusy) return;
    if (
      mode === "replace" &&
      !window.confirm("Replace all PDFs, annotations, and settings with this backup? This cannot be undone.")
    ) return;

    setBackupBusy(true);
    backupProgress.hidden = false;
    backupProgress.value = 0;
    let lastPercent = -1;
    try {
      const sourcePdfs = Array.isArray(pendingBackup.pdfs) ? pendingBackup.pdfs : [];
      const pdfBytes = sourcePdfs.reduce(
        (total, pdf) => total + (
          pdf && typeof pdf.data === "string" ? Math.floor((pdf.data.length * 3) / 4) : 0
        ),
        0
      );
      backupProgress.max = Math.max(1, pdfBytes);
      const result = await importBackup(pendingBackup, mode, (progress) => {
        const total = Math.max(1, progress.totalBytes);
        const percent = Math.floor((progress.completedBytes / total) * 100);
        if (percent !== lastPercent || progress.phase === "saving") {
          lastPercent = percent;
          updateBackupProgress(progress);
        }
      });
      pendingBackup = null;
      backupModePanel.hidden = true;
      backupFileInput.value = "";
      await refresh();
      showBackupMessage(
        `Restore complete: ${result.pdfCount} PDF${result.pdfCount === 1 ? "" : "s"}, ` +
        `${result.annotationCount} annotation page${result.annotationCount === 1 ? "" : "s"}, ` +
        `${result.settingCount} setting${result.settingCount === 1 ? "" : "s"}. Reloading…`
      );
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      showBackupMessage(`Could not restore backup: ${error.message}`);
    } finally {
      setBackupBusy(false);
      backupProgress.hidden = true;
    }
  }

  function formatOpened(pdf) {
    if (!pdf.lastOpenedAt) return "Not opened yet";
    return `Opened ${new Date(pdf.lastOpenedAt).toLocaleDateString()}`;
  }

  function createPdfCard(pdf) {
    const item = document.createElement("li");
    item.className = "pdf-card";

    const openButton = document.createElement("button");
    openButton.className = "pdf-open";
    openButton.type = "button";
    openButton.addEventListener("click", () => onOpen(pdf));

    const title = document.createElement("span");
    title.className = "pdf-name";
    title.textContent = pdf.name;

    const metadata = document.createElement("span");
    metadata.className = "pdf-meta";
    const pages = Number.isInteger(pdf.pageCount) ? `${pdf.pageCount} pages` : "Page count shown when opened";
    metadata.textContent = `${pages} · ${formatOpened(pdf)}`;
    openButton.append(title, metadata);

    const actions = document.createElement("div");
    actions.className = "pdf-actions";

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.textContent = "Rename";
    renameButton.setAttribute("aria-label", `Rename ${pdf.name}`);
    renameButton.addEventListener("click", async () => {
      const proposedName = window.prompt("New title", pdf.name);
      if (proposedName === null) return;
      const name = proposedName.trim();
      if (!name) {
        showMessage("A title cannot be empty.");
        return;
      }
      try {
        await renamePdf(pdf.id, name);
        await refresh();
        showMessage("Title updated.");
      } catch (error) {
        showMessage(`Could not rename PDF: ${error.message}`);
      }
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", `Delete ${pdf.name}`);
    deleteButton.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${pdf.name}" from your library?`)) return;
      try {
        await deletePdf(pdf.id);
        await refresh();
        showMessage("PDF deleted.");
      } catch (error) {
        showMessage(`Could not delete PDF: ${error.message}`);
      }
    });

    actions.append(renameButton, deleteButton);
    item.append(openButton, actions);
    return item;
  }

  async function refresh() {
    const pdfs = await listPdfs();
    pdfList.replaceChildren(...pdfs.map(createPdfCard));
    emptyLibrary.hidden = pdfs.length > 0;
    return pdfs;
  }

  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    if (!files.length) return;

    let imported = 0;
    const errors = [];
    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer();
        const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
        const signature = String.fromCharCode(...header);
        if (!signature.includes("%PDF-")) {
          throw new Error(`${file.name} is not a valid PDF file.`);
        }
        await addPdf(buffer, file.name.replace(/\.pdf$/i, ""));
        imported += 1;
      } catch (error) {
        errors.push(error.message);
      }
    }

    try {
      await refresh();
    } catch (error) {
      showMessage(`Could not load the library: ${error.message}`);
      return;
    }

    if (errors.length) {
      showMessage(`${imported} imported. ${errors.join(" ")}`);
    } else {
      showMessage(`${imported} PDF${imported === 1 ? "" : "s"} imported.`);
    }
  });

  exportBackupButton.addEventListener("click", async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    backupProgress.hidden = false;
    backupProgress.value = 0;
    try {
      const pdfs = await listPdfs();
      const estimatedBytes = pdfs.reduce((total, pdf) => {
        if (!(pdf.data instanceof ArrayBuffer)) return total;
        return total + Math.ceil(pdf.data.byteLength * 4 / 3);
      }, 0);
      if (
        estimatedBytes >= 50 * 1024 * 1024 &&
        !window.confirm(`This backup may be about ${formatBytes(estimatedBytes)}. Continue?`)
      ) return;

      const backup = await exportBackup(updateBackupProgress);
      const contents = JSON.stringify(backup);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFile = new File(
        [contents],
        `sheetmusic-backup-${timestamp}.json`,
        { type: "application/json" }
      );
      await shareOrDownloadBackup(backupFile);
    } catch (error) {
      showBackupMessage(`Could not export backup: ${error.message}`);
    } finally {
      setBackupBusy(false);
      backupProgress.hidden = true;
    }
  });

  importBackupButton.addEventListener("click", () => backupFileInput.click());
  backupFileInput.addEventListener("change", async () => {
    const file = backupFileInput.files && backupFileInput.files[0];
    if (!file) return;
    backupFileInput.value = "";
    showBackupMessage("Reading backup file…");
    try {
      const backup = JSON.parse(await file.text());
      if (!backup || backup.formatVersion !== 1) {
        throw new Error("Unsupported backup format.");
      }
      pendingBackup = backup;
      backupModePanel.hidden = false;
      showBackupMessage("Choose Merge or Replace all to continue.");
    } catch (error) {
      showBackupMessage(`Could not read backup: ${error.message}`);
    }
  });
  mergeBackupButton.addEventListener("click", () => restorePendingBackup("merge"));
  replaceBackupButton.addEventListener("click", () => restorePendingBackup("replace"));
  cancelBackupButton.addEventListener("click", () => {
    pendingBackup = null;
    backupModePanel.hidden = true;
    showBackupMessage("");
  });

  return {
    refresh
  };
}
