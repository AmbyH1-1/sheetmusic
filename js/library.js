import { addPdf, deletePdf, listPdfs, renamePdf } from "./db.js";

export function createLibrary({ onOpen }) {
  const importButton = document.querySelector("#importButton");
  const fileInput = document.querySelector("#fileInput");
  const pdfList = document.querySelector("#pdfList");
  const emptyLibrary = document.querySelector("#emptyLibrary");
  const message = document.querySelector("#libraryMessage");

  function showMessage(text) {
    message.textContent = text;
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

  return {
    refresh
  };
}
