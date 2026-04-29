import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = new Set(["pdf", "docx"]);
const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

class FileParserError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "FileParserError";
    this.code = options.code || "FILE_PARSER_ERROR";
    this.details = options.details || null;
  }
}

function getExtension(filename = "") {
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function normalizeExtractedText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function inferTextQuality(text) {
  const normalized = normalizeExtractedText(text);
  const wordCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
  const charCount = normalized.length;
  return { charCount, wordCount, isLikelyReadable: charCount >= 120 && wordCount >= 20 };
}

async function readAsArrayBuffer(file) {
  try {
    return await file.arrayBuffer();
  } catch (error) {
    throw new FileParserError("File tidak dapat dibaca oleh browser.", {
      code: "FILE_READ_FAILED",
      details: error?.message || null,
    });
  }
}

function validateCVFile(file) {
  if (!file) throw new FileParserError("Pilih file CV terlebih dahulu.", { code: "FILE_REQUIRED" });

  const extension = getExtension(file.name);
  const hasAcceptedExtension = ACCEPTED_EXTENSIONS.has(extension);
  const hasAcceptedMimeType = ACCEPTED_MIME_TYPES.has(file.type);

  if (!hasAcceptedExtension && !hasAcceptedMimeType) {
    throw new FileParserError("Format file tidak didukung. Gunakan PDF atau DOCX.", {
      code: "UNSUPPORTED_FILE_TYPE",
    });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new FileParserError("Ukuran file melebihi 5MB. Kompres file atau gunakan versi yang lebih ringan.", {
      code: "FILE_TOO_LARGE",
    });
  }

  if (file.size <= 0) throw new FileParserError("File kosong. Pilih file CV yang valid.", { code: "EMPTY_FILE" });

  return true;
}

async function extractTextFromPDF(file, options = {}) {
  const { onProgress } = options;
  const arrayBuffer = await readAsArrayBuffer(file);
  let pdf;

  try {
    pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      useSystemFonts: true,
      disableFontFace: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    if (error?.name === "PasswordException") {
      throw new FileParserError("PDF ini dilindungi password. Gunakan file PDF tanpa password.", {
        code: "PDF_PASSWORD_PROTECTED",
      });
    }
    throw new FileParserError("PDF gagal dibuka. Pastikan file tidak rusak.", {
      code: "PDF_LOAD_FAILED",
      details: error?.message || null,
    });
  }

  const pages = [];
  const totalPages = pdf.numPages || 0;

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    const text = buildTextFromPDFItems(content.items);
    if (text) pages.push(`Halaman ${pageNumber}\n${text}`);
    page.cleanup();

    if (typeof onProgress === "function") {
      onProgress({ fileType: "pdf", pageNumber, totalPages });
    }
  }

  await pdf.destroy();

  const extractedText = normalizeExtractedText(pages.join("\n\n"));
  const quality = inferTextQuality(extractedText);

  if (!quality.isLikelyReadable) {
    throw new FileParserError(
      "Teks dalam PDF tidak terbaca dengan baik. File mungkin berupa scan gambar. Gunakan PDF berbasis teks atau DOCX.",
      { code: "PDF_TEXT_NOT_READABLE", details: quality },
    );
  }

  return { text: extractedText, metadata: { pageCount: totalPages, ...quality } };
}

function buildTextFromPDFItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "";

  const rows = new Map();
  const tolerance = 4;

  for (const item of items) {
    if (!item || typeof item.str !== "string") continue;
    const text = item.str.trim();
    if (!text) continue;

    const transform = item.transform || [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const rowKey = [...rows.keys()].find((key) => Math.abs(key - y) <= tolerance) ?? y;

    if (!rows.has(rowKey)) rows.set(rowKey, []);
    rows.get(rowKey).push({ x, text });
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((item) => item.text).join(" ").trim())
    .filter(Boolean)
    .join("\n");
}

async function extractTextFromDOCX(file) {
  if (!window.mammoth || typeof window.mammoth.extractRawText !== "function") {
    throw new FileParserError("Parser DOCX belum siap. Muat ulang halaman, lalu coba lagi.", {
      code: "MAMMOTH_NOT_READY",
    });
  }

  const arrayBuffer = await readAsArrayBuffer(file);

  try {
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    const extractedText = normalizeExtractedText(result.value || "");
    const quality = inferTextQuality(extractedText);

    if (!quality.isLikelyReadable) {
      throw new FileParserError("Teks dalam DOCX terlalu sedikit atau tidak terbaca.", {
        code: "DOCX_TEXT_NOT_READABLE",
        details: quality,
      });
    }

    return { text: extractedText, metadata: { warnings: result.messages?.length || 0, ...quality } };
  } catch (error) {
    if (error instanceof FileParserError) throw error;
    throw new FileParserError("DOCX gagal dibaca. Pastikan file tidak rusak.", {
      code: "DOCX_EXTRACT_FAILED",
      details: error?.message || null,
    });
  }
}

async function parseCVFile(file, options = {}) {
  validateCVFile(file);

  const extension = getExtension(file.name);
  const { onStatus, onProgress } = options;

  if (typeof onStatus === "function") onStatus("Mengekstrak konten dokumen...");

  const result =
    extension === "pdf" || file.type === "application/pdf"
      ? await extractTextFromPDF(file, { onProgress })
      : await extractTextFromDOCX(file);

  return {
    text: result.text,
    fileMetadata: {
      name: file.name || "cv",
      size: file.size || 0,
      sizeLabel: formatBytes(file.size || 0),
      type: extension === "pdf" ? "PDF" : "DOCX",
      mimeType: file.type || "unknown",
      extension: extension ? `.${extension}` : "",
      parser: extension === "pdf" ? "pdf.js" : "mammoth.js",
      extraction: result.metadata,
    },
  };
}

export {
  FileParserError,
  MAX_FILE_SIZE_BYTES,
  formatBytes,
  getExtension,
  normalizeExtractedText,
  parseCVFile,
  validateCVFile,
};
