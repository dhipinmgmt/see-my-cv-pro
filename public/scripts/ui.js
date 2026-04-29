import { formatReviewAsPlainText, downloadTextFile } from "./api.js";
import { formatBytes } from "./fileParser.js";

const CONSENT_STORAGE_KEY = "see-my-cv:pdp-consent";

const LOADING_STEPS = [
  ["Mengekstrak konten dokumen...", "Sistem sedang membaca isi CV secara sementara di browser Anda."],
  ["Menganalisis dengan Senior HR AI...", "CV dinilai berdasarkan target posisi, pengalaman, dan job description."],
  ["Membuat audit CV Anda...", "AI sedang menyusun skor, risiko penolakan, dan prioritas perbaikan."],
];

function qs(selector, root = document) {
  return root.querySelector(selector);
}

function setHidden(el, value = true) {
  if (el) el.hidden = value;
}

function setText(el, value = "") {
  if (el) el.textContent = value;
}

function clear(el) {
  if (!el) return;
  while (el.firstChild) el.firstChild.remove();
}

function showToast(message, type = "default") {
  let root = qs("[data-toast-root]");
  if (!root) {
    root = document.createElement("div");
    root.className = "toast-root";
    root.dataset.toastRoot = "";
    root.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
  }

  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  root.appendChild(item);

  window.setTimeout(() => item.remove(), 2800);
}

function hasConsent() {
  try {
    return sessionStorage.getItem(CONSENT_STORAGE_KEY) === "accepted";
  } catch {
    return false;
  }
}

function saveConsent() {
  try {
    sessionStorage.setItem(CONSENT_STORAGE_KEY, "accepted");
  } catch {
    return false;
  }
  return true;
}

function createUI() {
  const elements = {
    consentGate: qs("[data-consent-gate]"),
    consentCheckbox: qs("[data-consent-checkbox]"),
    consentContinue: qs("[data-consent-continue]"),
    appHeader: qs("[data-app-header]"),
    main: qs("[data-main]"),

    uploadSection: qs("[data-upload-section]"),
    uploadForm: qs("[data-upload-form]"),
    dropZone: qs("[data-drop-zone]"),
    fileInput: qs("[data-file-input]"),
    uploadError: qs("[data-upload-error]"),
    filePreview: qs("[data-file-preview]"),
    fileName: qs("[data-file-name]"),
    fileSize: qs("[data-file-size]"),
    fileType: qs("[data-file-type]"),
    fileBadge: qs("[data-file-badge]"),
    removeFile: qs("[data-remove-file]"),
    reviewButton: qs("[data-review-button]"),

    targetRole: qs("[data-target-role]"),
    industry: qs("[data-industry]"),
    experienceLevel: qs("[data-experience-level]"),
    reviewMode: qs("[data-review-mode]"),
    jobDescription: qs("[data-job-description]"),

    loadingSection: qs("[data-loading-section]"),
    loadingTitle: qs("[data-loading-title]"),
    loadingDescription: qs("[data-loading-description]"),
    usedModel: qs("[data-used-model]"),

    resultSection: qs("[data-result-section]"),
    scoreRing: qs("[data-score-ring]"),
    scoreValue: qs("[data-score-value]"),
    summaryText: qs("[data-summary-text]"),
    verdictText: qs("[data-verdict-text]"),
    firstImpression: qs("[data-first-impression]"),
    targetFitScore: qs("[data-target-fit-score]"),
    targetFitAssessment: qs("[data-target-fit-assessment]"),
    resultProvider: qs("[data-result-provider]"),

    dimensionList: qs("[data-dimension-list]"),
    strengthsList: qs("[data-strengths-list]"),
    criticalWeaknessesList: qs("[data-critical-weaknesses-list]"),
    fatalMistakesList: qs("[data-fatal-mistakes-list]"),
    rejectionRisksList: qs("[data-rejection-risks-list]"),
    priorityFixesList: qs("[data-priority-fixes-list]"),
    sectionReviewList: qs("[data-section-review-list]"),
    rewriteExamplesList: qs("[data-rewrite-examples-list]"),
    recommendationsList: qs("[data-recommendations-list]"),

    copyResult: qs("[data-copy-result]"),
    downloadResult: qs("[data-download-result]"),
    resetReview: qs("[data-reset-review]"),

    errorSection: qs("[data-error-section]"),
    errorMessage: qs("[data-error-message]"),
    errorReset: qs("[data-error-reset]"),
  };

  const state = {
    selectedFile: null,
    latestReviewPayload: null,
    loadingTimer: null,
    loadingIndex: 0,
  };

  function init() {
    bindConsent();
    bindUpload();
    bindResult();
    applyConsentState();
  }

  function applyConsentState() {
    if (hasConsent()) {
      revealApp(false);
      return;
    }
    setHidden(elements.consentGate, false);
    setHidden(elements.appHeader, true);
    setHidden(elements.main, true);
  }

  function bindConsent() {
    elements.consentCheckbox?.addEventListener("change", () => {
      elements.consentContinue.disabled = !elements.consentCheckbox.checked;
    });

    elements.consentContinue?.addEventListener("click", () => {
      if (!elements.consentCheckbox?.checked) return;
      saveConsent();
      revealApp(true);
    });
  }

  function revealApp(animate = true) {
    setHidden(elements.appHeader, false);
    setHidden(elements.main, false);

    if (!elements.consentGate) return;

    if (!animate) {
      setHidden(elements.consentGate, true);
      return;
    }

    elements.consentGate.classList.add("is-exiting");
    elements.consentGate.addEventListener("animationend", () => setHidden(elements.consentGate, true), { once: true });
  }

  function bindUpload() {
    elements.fileInput?.addEventListener("change", (event) => {
      const [file] = event.target.files || [];
      selectFile(file);
    });

    elements.removeFile?.addEventListener("click", clearSelectedFile);

    ["dragenter", "dragover"].forEach((eventName) => {
      elements.dropZone?.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.add("is-dragging");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      elements.dropZone?.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove("is-dragging");
      });
    });

    elements.dropZone?.addEventListener("drop", (event) => {
      const [file] = event.dataTransfer.files || [];
      selectFile(file);
    });
  }

  function bindResult() {
    elements.copyResult?.addEventListener("click", async () => {
      if (!state.latestReviewPayload) return;
      const text = formatReviewAsPlainText(state.latestReviewPayload);
      try {
        await navigator.clipboard.writeText(text);
        showToast("Hasil audit berhasil disalin.", "success");
      } catch {
        fallbackCopy();
      }
    });

    elements.downloadResult?.addEventListener("click", () => {
      if (!state.latestReviewPayload) return;
      downloadTextFile(buildFilename(state.selectedFile?.name), formatReviewAsPlainText(state.latestReviewPayload));
      showToast("File .txt berhasil dibuat.", "success");
    });

    elements.resetReview?.addEventListener("click", resetReviewState);
    elements.errorReset?.addEventListener("click", resetErrorState);
  }

  function selectFile(file) {
    clearUploadError();

    if (!file) {
      clearSelectedFile();
      return;
    }

    state.selectedFile = file;
    const extension = file.name.split(".").pop()?.toUpperCase() || "DOC";

    setText(elements.fileName, file.name);
    setText(elements.fileSize, formatBytes(file.size));
    setText(elements.fileType, extension === "PDF" ? "PDF" : "DOCX");
    setText(elements.fileBadge, extension === "PDF" ? "PDF" : "DOC");
    setHidden(elements.filePreview, false);
    elements.reviewButton.disabled = false;
  }

  function clearSelectedFile() {
    state.selectedFile = null;
    if (elements.fileInput) elements.fileInput.value = "";
    setHidden(elements.filePreview, true);
    elements.reviewButton.disabled = true;
  }

  function getSelectedFile() {
    return state.selectedFile;
  }

  function getCareerContext() {
    return {
      targetRole: elements.targetRole?.value?.trim() || "",
      industry: elements.industry?.value?.trim() || "",
      experienceLevel: elements.experienceLevel?.value || "Junior",
      reviewMode: elements.reviewMode?.value || "senior_hr",
      jobDescription: elements.jobDescription?.value?.trim() || "",
    };
  }

  function validateCareerContext() {
    const context = getCareerContext();
    if (!context.targetRole || context.targetRole.length < 3) {
      return { valid: false, message: "Isi target posisi terlebih dahulu. Contoh: Digital Marketing Specialist." };
    }
    return { valid: true, context };
  }

  function showUploadError(message) {
    setText(elements.uploadError, message);
    setHidden(elements.uploadError, false);
  }

  function clearUploadError() {
    setText(elements.uploadError, "");
    setHidden(elements.uploadError, true);
  }

  function showLoading({ providerName = "model AI terbaik yang tersedia" } = {}) {
    stopLoadingCycle();
    state.loadingIndex = 0;
    setLoadingStep(0);
    setText(elements.usedModel, `Ditenagai oleh ${providerName}`);

    setHidden(elements.uploadSection, true);
    setHidden(elements.resultSection, true);
    setHidden(elements.errorSection, true);
    setHidden(elements.loadingSection, false);

    state.loadingTimer = window.setInterval(() => {
      state.loadingIndex = (state.loadingIndex + 1) % LOADING_STEPS.length;
      setLoadingStep(state.loadingIndex);
    }, 1800);
  }

  function setLoadingStep(index) {
    const [title, description] = LOADING_STEPS[index] || LOADING_STEPS[0];
    setText(elements.loadingTitle, title);
    setText(elements.loadingDescription, description);
  }

  function setLoadingStatus(title, description) {
    stopLoadingCycle();
    if (title) setText(elements.loadingTitle, title);
    if (description) setText(elements.loadingDescription, description);
  }

  function setActiveModel(modelName) {
    if (modelName) setText(elements.usedModel, `Ditenagai oleh ${modelName}`);
  }

  function stopLoadingCycle() {
    if (state.loadingTimer) {
      window.clearInterval(state.loadingTimer);
      state.loadingTimer = null;
    }
  }

  function showResult(payload) {
    stopLoadingCycle();
    state.latestReviewPayload = payload;

    const review = payload.review || {};
    const score = review.score || 0;

    setHidden(elements.loadingSection, true);
    setHidden(elements.uploadSection, true);
    setHidden(elements.errorSection, true);
    setHidden(elements.resultSection, false);

    setText(elements.summaryText, review.summary);
    setText(elements.verdictText, review.verdict);
    setText(elements.firstImpression, review.seniorHrFirstImpression);
    setText(elements.targetFitScore, String(review.targetRoleFit?.score || 0));
    setText(elements.targetFitAssessment, review.targetRoleFit?.assessment || "");
    setText(elements.resultProvider, `Provider AI: ${payload.usedProvider} • ${payload.usedModel}`);

    renderDimensions(review.dimensionScores);
    renderList(elements.strengthsList, review.strengths, "Belum ada kekuatan spesifik.");
    renderList(elements.criticalWeaknessesList, review.criticalWeaknesses, "Belum ada kelemahan kritis.");
    renderList(elements.fatalMistakesList, review.fatalMistakes, "Tidak ada kesalahan fatal yang terdeteksi.");
    renderList(elements.rejectionRisksList, review.rejectionRisks, "Belum ada risiko penolakan.");
    renderPriority(review.priorityFixes);
    renderSections(review.sectionReviews);
    renderRewrite(review.rewriteExamples);
    renderList(elements.recommendationsList, review.recommendations, "Belum ada rekomendasi.");

    animateScore(score);
    elements.resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderList(container, items = [], emptyMessage) {
    clear(container);
    const safeItems = Array.isArray(items) && items.length ? items : [emptyMessage];

    safeItems.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      container?.appendChild(li);
    });
  }

  function renderDimensions(items = []) {
    clear(elements.dimensionList);
    const safeItems = Array.isArray(items) && items.length ? items : [{ name: "Dimensi", score: 0, note: "Belum ada skor." }];

    safeItems.forEach((item) => {
      const article = document.createElement("article");
      article.className = "dimension-item";
      article.innerHTML = `
        <div>
          <h4></h4>
          <p></p>
        </div>
        <span></span>
      `;
      setText(article.querySelector("h4"), item.name);
      setText(article.querySelector("p"), item.note);
      setText(article.querySelector("span"), `${item.score}/100`);
      elements.dimensionList?.appendChild(article);
    });
  }

  function renderPriority(items = []) {
    clear(elements.priorityFixesList);
    const safeItems = Array.isArray(items) && items.length ? items : [{
      priority: 1,
      issue: "Belum ada prioritas perbaikan.",
      action: "Coba ulangi review dengan CV yang lebih jelas.",
      impact: "Sedang",
    }];

    safeItems.forEach((item, index) => {
      const article = document.createElement("article");
      article.className = "priority-item";
      article.innerHTML = `
        <span></span>
        <div>
          <h4></h4>
          <p></p>
          <small></small>
        </div>
      `;
      setText(article.querySelector("span"), String(item.priority || index + 1));
      setText(article.querySelector("h4"), item.issue);
      setText(article.querySelector("p"), item.action);
      setText(article.querySelector("small"), `Dampak: ${item.impact}`);
      elements.priorityFixesList?.appendChild(article);
    });
  }

  function renderSections(items = []) {
    clear(elements.sectionReviewList);
    const safeItems = Array.isArray(items) && items.length ? items : [{
      title: "Struktur CV",
      score: 0,
      feedback: "Belum ada review per bagian.",
    }];

    safeItems.forEach((item) => {
      const article = document.createElement("article");
      article.className = "section-review-item";
      article.innerHTML = `
        <div>
          <h4></h4>
          <p></p>
        </div>
        <span></span>
      `;
      setText(article.querySelector("h4"), item.title);
      setText(article.querySelector("p"), item.feedback);
      setText(article.querySelector("span"), `${item.score}/100`);
      elements.sectionReviewList?.appendChild(article);
    });
  }

  function renderRewrite(items = []) {
    clear(elements.rewriteExamplesList);
    const safeItems = Array.isArray(items) && items.length ? items : [{
      section: "Contoh rewrite",
      before: "Tidak ada contoh spesifik dari CV.",
      after: "Tambahkan deskripsi yang lebih spesifik, relevan, dan jika memungkinkan terukur.",
    }];

    safeItems.forEach((item) => {
      const article = document.createElement("article");
      article.className = "rewrite-item";
      article.innerHTML = `
        <h4></h4>
        <div class="rewrite-comparison">
          <div><strong>Sebelum</strong><p class="before"></p></div>
          <div><strong>Sesudah</strong><p class="after"></p></div>
        </div>
      `;
      setText(article.querySelector("h4"), item.section);
      setText(article.querySelector(".before"), item.before);
      setText(article.querySelector(".after"), item.after);
      elements.rewriteExamplesList?.appendChild(article);
    });
  }

  function animateScore(targetScore) {
    const score = Math.max(0, Math.min(100, Math.round(targetScore || 0)));
    const start = performance.now();
    const duration = 900;

    if (elements.scoreRing) elements.scoreRing.style.setProperty("--score", "0");
    setText(elements.scoreValue, "0");

    requestAnimationFrame(() => elements.scoreRing?.style.setProperty("--score", String(score)));

    function tick(now) {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setText(elements.scoreValue, String(Math.round(score * eased)));
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function showError(message) {
    stopLoadingCycle();
    setText(elements.errorMessage, message || "Review belum bisa diproses.");
    setHidden(elements.loadingSection, true);
    setHidden(elements.resultSection, true);
    setHidden(elements.uploadSection, true);
    setHidden(elements.errorSection, false);
    elements.errorSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetErrorState() {
    stopLoadingCycle();
    setHidden(elements.errorSection, true);
    setHidden(elements.loadingSection, true);
    setHidden(elements.resultSection, true);
    setHidden(elements.uploadSection, false);
  }

  function resetReviewState() {
    stopLoadingCycle();
    state.latestReviewPayload = null;
    clearSelectedFile();
    clearUploadError();
    setHidden(elements.loadingSection, true);
    setHidden(elements.resultSection, true);
    setHidden(elements.errorSection, true);
    setHidden(elements.uploadSection, false);
    elements.uploadSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setReviewButtonLoading(isLoading) {
    if (!elements.reviewButton) return;
    elements.reviewButton.disabled = isLoading || !state.selectedFile;
    elements.reviewButton.textContent = isLoading ? "Memproses..." : "Audit CV Sekarang";
  }

  function fallbackCopy() {
    // navigator.clipboard failed — browser does not allow programmatic copy.
    // Guide the user to the download button which is always available.
    showToast(
      "Browser ini tidak mendukung salin otomatis. Gunakan tombol Unduh (.txt) untuk menyimpan hasil audit.",
      "error"
    );
  }

  function buildFilename(originalName = "cv") {
    const base = originalName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "cv";
    return `see-my-cv-audit-${base}-${new Date().toISOString().slice(0, 10)}.txt`;
  }

  return {
    elements,
    init,
    getSelectedFile,
    getCareerContext,
    validateCareerContext,
    showUploadError,
    clearUploadError,
    showLoading,
    setLoadingStatus,
    setActiveModel,
    showResult,
    showError,
    setReviewButtonLoading,
  };
}

export { createUI };
