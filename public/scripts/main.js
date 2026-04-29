import { requestCVReview } from "./api.js";
import { FileParserError, parseCVFile, validateCVFile } from "./fileParser.js";
import { createUI } from "./ui.js";

const ui = createUI();

function initApp() {
  ui.init();
  bindReviewFlow();
  bindGlobalErrorHandlers();
}

function bindReviewFlow() {
  const { uploadForm, fileInput } = ui.elements;

  uploadForm?.addEventListener("submit", handleReviewSubmit);

  fileInput?.addEventListener("change", () => {
    const file = ui.getSelectedFile();
    if (!file) return;

    try {
      validateCVFile(file);
      ui.clearUploadError();
    } catch (error) {
      ui.showUploadError(getFriendlyErrorMessage(error));
      ui.setReviewButtonLoading(false);
    }
  });
}

async function handleReviewSubmit(event) {
  event.preventDefault();

  const careerValidation = ui.validateCareerContext();

  if (!careerValidation.valid) {
    ui.showUploadError(careerValidation.message);
    return;
  }

  const file = ui.getSelectedFile();

  try {
    validateCVFile(file);
  } catch (error) {
    ui.showUploadError(getFriendlyErrorMessage(error));
    return;
  }

  ui.clearUploadError();
  ui.setReviewButtonLoading(true);
  ui.showLoading({ providerName: "Senior HR AI reviewer" });

  try {
    const parsed = await parseCVFile(file, {
      onStatus: (message) => {
        ui.setLoadingStatus(message, "Konten CV sedang diekstrak langsung di browser Anda.");
      },
      onProgress: (progress) => {
        if (!progress || progress.fileType !== "pdf") return;
        ui.setLoadingStatus("Mengekstrak konten dokumen...", `Membaca halaman ${progress.pageNumber} dari ${progress.totalPages}.`);
      },
    });

    ui.setLoadingStatus(
      "Menganalisis dengan Senior HR AI...",
      "CV dinilai berdasarkan target posisi, job description, dan standar seleksi recruiter.",
    );
    ui.setActiveModel("Gemini, lalu fallback otomatis bila diperlukan");

    const result = await requestCVReview({
      extractedText: parsed.text,
      fileMetadata: parsed.fileMetadata,
      careerContext: ui.getCareerContext(),
    });

    ui.setActiveModel(`${result.usedProvider} • ${result.usedModel}`);
    ui.setLoadingStatus("Membuat audit CV Anda...", "AI sudah selesai membaca CV dan sedang menyiapkan hasil audit.");

    await wait(320);
    ui.showResult(result);
  } catch (error) {
    ui.showError(getFriendlyErrorMessage(error));
  } finally {
    ui.setReviewButtonLoading(false);
  }
}

function getFriendlyErrorMessage(error) {
  if (!error) return "Terjadi kesalahan yang tidak diketahui.";
  if (error instanceof FileParserError) return error.message;
  if (typeof error.message === "string" && error.message.trim()) return error.message;
  return "Review CV belum bisa diproses. Coba gunakan file lain atau ulangi beberapa saat lagi.";
}

function bindGlobalErrorHandlers() {
  window.addEventListener("error", (event) => {
    const message = event?.error?.message || event?.message || "Kesalahan aplikasi tidak diketahui.";
    console.error("Application error:", message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason?.message || event?.reason || "Promise rejection tidak diketahui.";
    console.error("Unhandled promise rejection:", reason);
  });
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp, { once: true });
} else {
  initApp();
}
