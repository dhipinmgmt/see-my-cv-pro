const REVIEW_ENDPOINT = "/api/review";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_EXTRACTED_TEXT_LENGTH = 60_000;

class APIError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "APIError";
    this.status = options.status || 500;
    this.code = options.code || "API_ERROR";
    this.details = options.details || null;
  }
}

function normalizeText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{4,}/g, "\n\n\n").trim();
}

function truncateTextForReview(text) {
  const normalized = normalizeText(text);
  if (normalized.length <= MAX_EXTRACTED_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, 42000)}\n\n[Konten dipotong otomatis karena terlalu panjang.]\n\n${normalized.slice(-18000)}`;
}

function safeString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean).slice(0, 12);
}

function normalizeReview(review) {
  return {
    score: clampScore(review.score),
    summary: safeString(review.summary, "Belum ada ringkasan."),
    verdict: safeString(review.verdict, "Belum ada final verdict."),
    seniorHrFirstImpression: safeString(review.seniorHrFirstImpression, "Belum ada kesan awal."),
    targetRoleFit: {
      score: clampScore(review.targetRoleFit?.score),
      assessment: safeString(review.targetRoleFit?.assessment, "Belum ada penilaian target posisi."),
    },
    dimensionScores: Array.isArray(review.dimensionScores) ? review.dimensionScores.map((item) => ({
      name: safeString(item?.name, "Dimensi"),
      score: clampScore(item?.score),
      note: safeString(item?.note, "Belum ada catatan."),
    })).slice(0, 10) : [],
    strengths: arrayOfStrings(review.strengths),
    criticalWeaknesses: arrayOfStrings(review.criticalWeaknesses || review.weaknesses),
    fatalMistakes: arrayOfStrings(review.fatalMistakes),
    rejectionRisks: arrayOfStrings(review.rejectionRisks),
    recommendations: arrayOfStrings(review.recommendations),
    priorityFixes: Array.isArray(review.priorityFixes) ? review.priorityFixes.map((item, index) => ({
      priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : index + 1,
      issue: safeString(item?.issue, "Masalah prioritas."),
      action: safeString(item?.action, "Tindakan perbaikan belum tersedia."),
      impact: safeString(item?.impact, "Sedang"),
    })).slice(0, 8) : [],
    sectionReviews: Array.isArray(review.sectionReviews) ? review.sectionReviews.map((item) => ({
      title: safeString(item?.title, "Bagian CV"),
      score: clampScore(item?.score),
      feedback: safeString(item?.feedback, "Belum ada feedback."),
    })).slice(0, 12) : [],
    rewriteExamples: Array.isArray(review.rewriteExamples) ? review.rewriteExamples.map((item) => ({
      section: safeString(item?.section, "Bagian CV"),
      before: safeString(item?.before, "Contoh sebelum tidak tersedia."),
      after: safeString(item?.after, "Contoh sesudah tidak tersedia."),
    })).slice(0, 8) : [],
  };
}

function sanitizePayloadText(value, max = 1000) {
  return safeString(value, "").slice(0, max);
}

function sanitizeCareerContext(context = {}) {
  return {
    targetRole: sanitizePayloadText(context.targetRole, 140),
    industry: sanitizePayloadText(context.industry, 120),
    experienceLevel: sanitizePayloadText(context.experienceLevel, 80),
    reviewMode: sanitizePayloadText(context.reviewMode || "senior_hr", 40),
    jobDescription: sanitizePayloadText(context.jobDescription, 12000),
  };
}

function sanitizeFileMetadata(meta = {}) {
  return {
    name: sanitizePayloadText(meta.name, 180) || "cv",
    type: sanitizePayloadText(meta.type, 80) || "unknown",
    size: Number.isFinite(Number(meta.size)) ? Number(meta.size) : 0,
    extension: sanitizePayloadText(meta.extension, 16).replace(/[^a-z0-9.]/gi, ""),
  };
}

async function safeReadJSON(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json().catch(() => null);
  const text = await response.text().catch(() => "");
  return text ? { message: text } : null;
}

async function requestCVReview({ extractedText, fileMetadata, careerContext }) {
  const text = truncateTextForReview(extractedText);

  if (!text) {
    throw new APIError("Teks CV kosong atau tidak berhasil diekstrak.", { status: 400, code: "EMPTY_EXTRACTED_TEXT" });
  }

  if (text.length < 120) {
    throw new APIError("Teks CV terlalu pendek untuk dianalisis. Pastikan file berisi konten CV yang dapat dibaca.", {
      status: 400,
      code: "TEXT_TOO_SHORT",
    });
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(REVIEW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      signal: controller.signal,
      body: JSON.stringify({
        extractedText: text,
        fileMetadata: sanitizeFileMetadata(fileMetadata),
        careerContext: sanitizeCareerContext(careerContext),
        locale: "id-ID",
      }),
    });

    const payload = await safeReadJSON(response);

    if (!response.ok) {
      throw new APIError(payload?.message || payload?.error || "Review CV belum bisa diproses.", {
        status: response.status,
        code: payload?.code || `HTTP_${response.status}`,
        details: payload?.details || null,
      });
    }

    if (!payload?.review) {
      throw new APIError("Format respons AI tidak valid.", { status: 502, code: "INVALID_AI_RESPONSE" });
    }

    return {
      usedProvider: payload.usedProvider || "AI Provider",
      usedModel: payload.usedModel || "Model AI",
      review: normalizeReview(payload.review),
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new APIError("Permintaan terlalu lama diproses. Coba lagi beberapa saat lagi.", {
        status: 408,
        code: "REQUEST_TIMEOUT",
      });
    }
    if (error instanceof APIError) throw error;
    throw new APIError("Koneksi ke server review gagal. Periksa koneksi internet Anda.", {
      status: 503,
      code: "NETWORK_ERROR",
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function formatReviewAsPlainText(payload) {
  const review = payload?.review || {};
  const lines = [];

  lines.push("HASIL SENIOR HR CV AUDIT");
  lines.push("========================");
  lines.push(`Provider: ${payload?.usedProvider || "-"}`);
  lines.push(`Model: ${payload?.usedModel || "-"}`);
  lines.push(`Skor Keseluruhan: ${review.score ?? "-"}/100`);
  lines.push("");
  lines.push("FINAL VERDICT");
  lines.push(review.verdict || "-");
  lines.push("");
  lines.push("RINGKASAN");
  lines.push(review.summary || "-");
  lines.push("");
  lines.push("KESAN SENIOR HR DALAM 10 DETIK PERTAMA");
  lines.push(review.seniorHrFirstImpression || "-");
  lines.push("");
  lines.push("KESESUAIAN DENGAN TARGET POSISI");
  lines.push(`${review.targetRoleFit?.score ?? "-"}/100`);
  lines.push(review.targetRoleFit?.assessment || "-");
  lines.push("");

  appendDimensions(lines, review.dimensionScores);
  appendList(lines, "KEKUATAN", review.strengths);
  appendList(lines, "KELEMAHAN KRITIS", review.criticalWeaknesses);
  appendList(lines, "KESALAHAN FATAL", review.fatalMistakes);
  appendList(lines, "POTENSI ALASAN CV DITOLAK", review.rejectionRisks);
  appendPriority(lines, review.priorityFixes);
  appendSections(lines, review.sectionReviews);
  appendRewrite(lines, review.rewriteExamples);
  appendList(lines, "SARAN & REKOMENDASI", review.recommendations);

  lines.push("Catatan privasi: Data Anda tidak pernah disimpan oleh aplikasi ini.");
  return lines.join("\n");
}

function appendList(lines, title, items) {
  lines.push(title);
  lines.push("-".repeat(title.length));
  if (Array.isArray(items) && items.length) items.forEach((item) => lines.push(`- ${item}`));
  else lines.push("- Tidak ada data.");
  lines.push("");
}

function appendDimensions(lines, items) {
  lines.push("SKOR PER DIMENSI");
  lines.push("----------------");
  if (Array.isArray(items) && items.length) items.forEach((item) => {
    lines.push(`- ${item.name}: ${item.score}/100`);
    lines.push(`  ${item.note}`);
  });
  else lines.push("- Tidak ada skor dimensi.");
  lines.push("");
}

function appendPriority(lines, items) {
  lines.push("PRIORITAS PERBAIKAN");
  lines.push("-------------------");
  if (Array.isArray(items) && items.length) items.forEach((item) => {
    lines.push(`${item.priority}. ${item.issue}`);
    lines.push(`   Tindakan: ${item.action}`);
    lines.push(`   Dampak: ${item.impact}`);
  });
  else lines.push("- Tidak ada prioritas perbaikan.");
  lines.push("");
}

function appendSections(lines, items) {
  lines.push("REVIEW PER BAGIAN");
  lines.push("-----------------");
  if (Array.isArray(items) && items.length) items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title} (${item.score}/100)`);
    lines.push(`   ${item.feedback}`);
  });
  else lines.push("- Tidak ada review per bagian.");
  lines.push("");
}

function appendRewrite(lines, items) {
  lines.push("CONTOH PERBAIKAN KALIMAT");
  lines.push("------------------------");
  if (Array.isArray(items) && items.length) items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.section}`);
    lines.push(`   Sebelum: ${item.before}`);
    lines.push(`   Sesudah: ${item.after}`);
  });
  else lines.push("- Tidak ada contoh rewrite.");
  lines.push("");
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { APIError, requestCVReview, formatReviewAsPlainText, downloadTextFile };
