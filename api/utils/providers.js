const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_MODEL_OUTPUT_TOKENS = 2800;

class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = options.provider || "unknown";
    this.status = options.status || 500;
    this.code = options.code || "PROVIDER_ERROR";
    this.isRateLimit = Boolean(options.isRateLimit);
    this.isRetryable = Boolean(options.isRetryable);
    this.details = options.details || null;
  }
}

function getEnv(name, fallback = "") {
  return process.env[name] && String(process.env[name]).trim() ? String(process.env[name]).trim() : fallback;
}

function getProviderConfig() {
  return {
    gemini: { apiKey: getEnv("GEMINI_API_KEY"), model: getEnv("GEMINI_MODEL", "gemini-3-flash-preview") },
    groq: { apiKey: getEnv("GROQ_API_KEY"), model: getEnv("GROQ_MODEL", "llama-3.3-70b-versatile") },
    mistral: { apiKey: getEnv("MISTRAL_API_KEY"), model: getEnv("MISTRAL_MODEL", "mistral-small-latest") },
    cohere: { apiKey: getEnv("COHERE_API_KEY"), model: getEnv("COHERE_MODEL", "command-r") },
    huggingface: { apiKey: getEnv("HUGGINGFACE_API_KEY"), model: getEnv("HUGGINGFACE_MODEL", "Qwen/Qwen2.5-72B-Instruct") },
  };
}

function buildSystemInstruction() {
  return [
    "Anda adalah Senior HR Reviewer dan recruiter profesional.",
    "Tugas Anda bukan menyenangkan kandidat, tetapi memberi audit CV yang jujur, objektif, kritis, dan actionable.",
    "Nilai CV berdasarkan target posisi, level pengalaman, industri, dan job description jika tersedia.",
    "Berani menyatakan bagian yang salah, lemah, ambigu, tidak relevan, atau berisiko membuat kandidat ditolak.",
    "Jangan mengarang pengalaman, pendidikan, sertifikasi, angka, tools, atau pencapaian yang tidak ada dalam CV.",
    "Jika informasi penting tidak ada, katakan bahwa informasi itu tidak ditemukan dan jelaskan dampaknya.",
    "Gunakan bahasa Indonesia yang natural seperti catatan reviewer Senior HR.",
    "Hindari pujian kosong. Setiap penilaian harus spesifik.",
    "Balas hanya dalam JSON valid tanpa markdown, tanpa komentar, dan tanpa teks tambahan.",
  ].join(" ");
}

function getDefaultReviewPrompt() {
  return `Analisis CV berikut sebagai Senior HR Reviewer.

Tujuan review:
- Detail, kritis, objektif, dan relevan dengan posisi yang dituju.
- Menilai apakah CV ini kompetitif untuk target posisi.
- Menunjukkan risiko penolakan recruiter.
- Memberi prioritas perbaikan yang praktis.
- Memberi contoh rewrite kalimat CV jika memungkinkan.

Mode review:
- balanced: kritis tetapi seimbang.
- senior_hr: tegas, objektif, natural seperti Senior HR.
- strict: lebih keras dan langsung pada kesalahan utama.
- rejection_risk: fokus pada alasan CV bisa ditolak.

Kembalikan JSON valid dengan struktur tepat seperti ini:
{
  "score": 74,
  "summary": "Ringkasan 2 sampai 4 kalimat tentang kualitas CV.",
  "verdict": "Final verdict yang jelas.",
  "seniorHrFirstImpression": "Kesan recruiter dalam 10 detik pertama.",
  "targetRoleFit": {
    "score": 70,
    "assessment": "Penilaian apakah CV cocok dengan target posisi."
  },
  "dimensionScores": [
    { "name": "Kesesuaian dengan target posisi", "score": 70, "note": "Catatan spesifik." },
    { "name": "Kekuatan pengalaman", "score": 70, "note": "Catatan spesifik." },
    { "name": "Kejelasan pencapaian", "score": 70, "note": "Catatan spesifik." },
    { "name": "Relevansi skill", "score": 70, "note": "Catatan spesifik." },
    { "name": "ATS keyword readiness", "score": 70, "note": "Catatan spesifik." },
    { "name": "Struktur dan keterbacaan", "score": 70, "note": "Catatan spesifik." }
  ],
  "strengths": ["Kekuatan 1", "Kekuatan 2", "Kekuatan 3"],
  "criticalWeaknesses": ["Kelemahan kritis 1", "Kelemahan kritis 2", "Kelemahan kritis 3"],
  "fatalMistakes": ["Kesalahan fatal 1", "Kesalahan fatal 2"],
  "rejectionRisks": ["Alasan CV bisa ditolak 1", "Alasan CV bisa ditolak 2"],
  "recommendations": ["Saran praktis 1", "Saran praktis 2", "Saran praktis 3"],
  "priorityFixes": [
    { "priority": 1, "issue": "Masalah utama.", "action": "Tindakan perbaikan spesifik.", "impact": "Sangat tinggi" }
  ],
  "sectionReviews": [
    { "title": "Profil/Ringkasan", "score": 70, "feedback": "Review singkat bagian ini." },
    { "title": "Pengalaman", "score": 75, "feedback": "Review singkat bagian ini." },
    { "title": "Skill", "score": 80, "feedback": "Review singkat bagian ini." },
    { "title": "Pendidikan", "score": 78, "feedback": "Review singkat bagian ini." },
    { "title": "Format dan ATS", "score": 72, "feedback": "Review singkat bagian ini." }
  ],
  "rewriteExamples": [
    { "section": "Pengalaman", "before": "Kalimat lama dari CV jika tersedia.", "after": "Versi yang lebih kuat dan relevan." }
  ]
}

Aturan penting:
- score harus angka 0 sampai 100.
- dimensionScores minimal 6 item.
- strengths 3 sampai 6 poin.
- criticalWeaknesses 3 sampai 6 poin.
- fatalMistakes 2 sampai 5 poin. Jika tidak fatal, tetap jelaskan area paling berisiko.
- rejectionRisks 3 sampai 6 poin.
- recommendations 4 sampai 8 poin.
- priorityFixes 3 sampai 6 item.
- rewriteExamples 2 sampai 5 contoh.
- Jangan menyebut bahwa Anda adalah AI.
- Jangan membuat data fiktif.
- Jika target posisi tidak sesuai dengan isi CV, katakan secara jelas.`;
}

function buildUserPrompt({ prompt, extractedText, fileMetadata, careerContext }) {
  return `${prompt || getDefaultReviewPrompt()}

Konteks target karier:
${JSON.stringify(careerContext || {}, null, 2)}

Metadata file:
${JSON.stringify(fileMetadata || {}, null, 2)}

Teks CV yang diekstrak:
${extractedText}`;
}

function getProviders() {
  const config = getProviderConfig();
  return [
    { name: "Google Gemini", model: config.gemini.model, enabled: Boolean(config.gemini.apiKey), call: (input) => callGemini(input, config.gemini) },
    { name: "Groq", model: config.groq.model, enabled: Boolean(config.groq.apiKey), call: (input) => callGroq(input, config.groq) },
    { name: "Mistral AI", model: config.mistral.model, enabled: Boolean(config.mistral.apiKey), call: (input) => callMistral(input, config.mistral) },
    { name: "Cohere", model: config.cohere.model, enabled: Boolean(config.cohere.apiKey), call: (input) => callCohere(input, config.cohere) },
    { name: "Hugging Face Inference", model: config.huggingface.model, enabled: Boolean(config.huggingface.apiKey), call: (input) => callHuggingFace(input, config.huggingface) },
  ];
}

async function callAIWithFallback({ prompt, extractedText, fileMetadata, careerContext }) {
  const providers = getProviders();
  const enabledProviders = providers.filter((p) => p.enabled);
  const skippedProviders = providers.filter((p) => !p.enabled).map((p) => p.name);

  if (!enabledProviders.length) {
    throw new ProviderError("Tidak ada API key provider AI yang dikonfigurasi.", {
      provider: "all",
      status: 500,
      code: "NO_PROVIDER_KEYS",
      details: { skippedProviders },
    });
  }

  const input = {
    systemInstruction: buildSystemInstruction(),
    userPrompt: buildUserPrompt({ prompt, extractedText, fileMetadata, careerContext }),
  };

  const failures = [];

  for (const provider of enabledProviders) {
    try {
      const rawText = await provider.call(input);
      const parsed = parseModelJSON(rawText);
      return {
        review: normalizeReview(parsed),
        usedProvider: provider.name,
        usedModel: provider.model,
        rawText,
        attemptedProviders: enabledProviders.map((p) => p.name),
        skippedProviders,
      };
    } catch (error) {
      const normalized = normalizeProviderError(error, provider.name);
      failures.push({
        provider: provider.name,
        model: provider.model,
        status: normalized.status,
        code: normalized.code,
        isRateLimit: normalized.isRateLimit,
        isRetryable: normalized.isRetryable,
      });
      continue;
    }
  }

  throw new ProviderError("Semua provider AI sedang tidak tersedia.", {
    provider: "all",
    status: 503,
    code: "ALL_PROVIDERS_FAILED",
    isRetryable: true,
    details: { failures, skippedProviders },
  });
}

async function callGemini(input, config) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const response = await fetchJSON(endpoint, {
    provider: "Google Gemini",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
      generationConfig: {
        temperature: 0.22,
        topP: 0.9,
        maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS,
        responseMimeType: "application/json",
      },
    }),
  });

  const text = response?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim();
  if (!text) throw emptyResponse("Google Gemini");
  return text;
}

async function callGroq(input, config) {
  const response = await fetchJSON("https://api.groq.com/openai/v1/chat/completions", {
    provider: "Groq",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.22,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });
  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) throw emptyResponse("Groq");
  return text;
}

async function callMistral(input, config) {
  const response = await fetchJSON("https://api.mistral.ai/v1/chat/completions", {
    provider: "Mistral AI",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.22,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });
  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) throw emptyResponse("Mistral AI");
  return text;
}

async function callCohere(input, config) {
  const response = await fetchJSON("https://api.cohere.ai/v2/chat", {
    provider: "Cohere",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.22,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });
  const content = response?.message?.content;
  const text = Array.isArray(content) ? content.map((item) => item.text || "").join("\n").trim() : "";
  if (!text) throw emptyResponse("Cohere");
  return text;
}

async function callHuggingFace(input, config) {
  const response = await fetchJSON("https://router.huggingface.co/v1/chat/completions", {
    provider: "Hugging Face Inference",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.22,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user", content: input.userPrompt },
      ],
    }),
  });
  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) throw emptyResponse("Hugging Face Inference");
  return text;
}

function emptyResponse(provider) {
  return new ProviderError(`${provider} tidak mengembalikan teks review.`, {
    provider,
    status: 502,
    code: "EMPTY_MODEL_RESPONSE",
    isRetryable: true,
  });
}

async function fetchJSON(url, options = {}) {
  const provider = options.provider || "AI Provider";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
    });

    const payload = await safeReadJSON(response);

    if (!response.ok) {
      throw new ProviderError(`Provider ${provider} gagal memproses permintaan.`, {
        provider,
        status: response.status,
        code: getProviderErrorCode(response.status, payload),
        isRateLimit: isRateLimitStatus(response.status, payload),
        isRetryable: isRetryableStatus(response.status),
        details: sanitizeProviderDetails(payload),
      });
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderError(`Provider ${provider} melewati batas waktu respons.`, {
        provider,
        status: 408,
        code: "PROVIDER_TIMEOUT",
        isRetryable: true,
      });
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`Koneksi ke provider ${provider} gagal.`, {
      provider,
      status: 503,
      code: "PROVIDER_NETWORK_ERROR",
      isRetryable: true,
      details: error?.message || null,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function safeReadJSON(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json().catch(() => null);
  const text = await response.text().catch(() => "");
  return text ? { message: text.slice(0, 500) } : null;
}

function sanitizeProviderDetails(payload) {
  if (!payload || typeof payload !== "object") return null;
  const message = payload.error?.message || payload.error || payload.message || payload.detail || payload.details || null;
  return message ? String(message).slice(0, 500) : null;
}

function getProviderErrorCode(status, payload) {
  if (status === 401 || status === 403) return "PROVIDER_AUTH_ERROR";
  if (status === 408) return "PROVIDER_TIMEOUT";
  if (status === 429) return "PROVIDER_RATE_LIMIT";
  if (status >= 500) return "PROVIDER_SERVER_ERROR";
  return payload?.error?.code || payload?.code || `PROVIDER_HTTP_${status}`;
}

function isRateLimitStatus(status, payload) {
  if (status === 429) return true;
  const detail = JSON.stringify(payload || {}).toLowerCase();
  return detail.includes("rate limit") || detail.includes("quota") || detail.includes("too many requests");
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function normalizeProviderError(error, providerName) {
  if (error instanceof ProviderError) return error;
  return new ProviderError(error?.message || `Provider ${providerName} gagal.`, {
    provider: providerName,
    status: 500,
    code: "UNKNOWN_PROVIDER_ERROR",
    isRetryable: true,
  });
}

function parseModelJSON(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new ProviderError("Respons AI kosong.", { provider: "parser", status: 502, code: "EMPTY_MODEL_RESPONSE", isRetryable: true });
  }

  const cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      throw new ProviderError("Respons AI bukan JSON valid.", { provider: "parser", status: 502, code: "INVALID_JSON_RESPONSE", isRetryable: true });
    }
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (error) {
      throw new ProviderError("JSON dari AI gagal diparse.", {
        provider: "parser",
        status: 502,
        code: "JSON_PARSE_FAILED",
        isRetryable: true,
        details: error?.message || null,
      });
    }
  }
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 60;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : fallback;
}

function list(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => text(item, "")).filter(Boolean).slice(0, 12);
  return items.length ? items : fallback;
}

function normalizeReview(review = {}) {
  return {
    score: clampScore(review.score),
    summary: text(review.summary, "CV berhasil dianalisis. Fokus perbaikan utama adalah struktur, relevansi target posisi, dan kekuatan pencapaian."),
    verdict: text(review.verdict, "CV ini memiliki potensi, tetapi masih perlu diperkuat agar lebih kompetitif."),
    seniorHrFirstImpression: text(review.seniorHrFirstImpression, "Dalam 10 detik pertama, CV belum cukup kuat menunjukkan value utama kandidat."),
    targetRoleFit: {
      score: clampScore(review.targetRoleFit?.score),
      assessment: text(review.targetRoleFit?.assessment, "Kesesuaian dengan target posisi perlu diperjelas."),
    },
    dimensionScores: normalizeDimensionScores(review.dimensionScores),
    strengths: list(review.strengths, ["CV sudah memiliki informasi dasar yang dapat dikembangkan."]),
    criticalWeaknesses: list(review.criticalWeaknesses || review.weaknesses, ["Beberapa bagian CV masih terlalu umum dan belum menunjukkan dampak kerja."]),
    fatalMistakes: list(review.fatalMistakes, ["CV belum menunjukkan pencapaian terukur yang cukup kuat."]),
    rejectionRisks: list(review.rejectionRisks, ["Recruiter dapat menilai CV ini kurang kompetitif karena bukti hasil kerja belum spesifik."]),
    recommendations: list(review.recommendations, ["Tambahkan pencapaian terukur, kata kunci relevan, dan struktur bagian yang lebih konsisten."]),
    priorityFixes: normalizePriorityFixes(review.priorityFixes),
    sectionReviews: normalizeSectionReviews(review.sectionReviews),
    rewriteExamples: normalizeRewriteExamples(review.rewriteExamples),
  };
}

function normalizeDimensionScores(value) {
  const fallback = [
    ["Kesesuaian dengan target posisi", 60, "CV perlu lebih menonjolkan pengalaman dan skill yang sesuai target posisi."],
    ["Kekuatan pengalaman", 60, "Pengalaman perlu dibuat lebih berbasis hasil, bukan sekadar tugas."],
    ["Kejelasan pencapaian", 55, "Pencapaian terukur masih perlu diperkuat."],
    ["Relevansi skill", 60, "Skill perlu disusun sesuai kebutuhan posisi."],
    ["ATS keyword readiness", 60, "Keyword penting perlu ditambahkan secara natural dan jujur."],
    ["Struktur dan keterbacaan", 65, "Struktur perlu dibuat lebih ringkas dan mudah discan."],
  ].map(([name, score, note]) => ({ name, score, note }));

  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => ({
    name: text(item?.name, "Dimensi penilaian"),
    score: clampScore(item?.score),
    note: text(item?.note, "Belum ada catatan."),
  })).filter((item) => item.name).slice(0, 10);
  return items.length ? items : fallback;
}

function normalizePriorityFixes(value) {
  const fallback = [
    { priority: 1, issue: "Profil singkat belum cukup tajam.", action: "Tulis ulang profil dengan menyebut target role, skill utama, dan nilai profesional.", impact: "Sangat tinggi" },
    { priority: 2, issue: "Pengalaman belum berbasis pencapaian.", action: "Ubah bullet pengalaman menjadi hasil kerja yang spesifik dan terukur.", impact: "Sangat tinggi" },
    { priority: 3, issue: "Keyword target posisi belum kuat.", action: "Tambahkan keyword relevan dari job description secara jujur.", impact: "Tinggi" },
  ];
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item, index) => ({
    priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : index + 1,
    issue: text(item?.issue, "Masalah prioritas"),
    action: text(item?.action, "Tindakan perbaikan belum tersedia."),
    impact: text(item?.impact, "Sedang"),
  })).slice(0, 8);
  return items.length ? items : fallback;
}

function normalizeSectionReviews(value) {
  const fallback = [
    { title: "Struktur CV", score: 60, feedback: "Struktur CV perlu dibuat lebih konsisten agar informasi utama mudah dibaca." },
    { title: "Pengalaman dan Pencapaian", score: 60, feedback: "Pengalaman perlu dilengkapi dampak kerja, angka, atau hasil terukur." },
    { title: "Skill dan Kata Kunci", score: 60, feedback: "Skill perlu disusun sesuai posisi tujuan dan diperkuat kata kunci relevan." },
  ];
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => ({
    title: text(item?.title, "Bagian CV"),
    score: clampScore(item?.score),
    feedback: text(item?.feedback, "Bagian ini perlu diperjelas agar lebih kuat."),
  })).slice(0, 12);
  return items.length ? items : fallback;
}

function normalizeRewriteExamples(value) {
  const fallback = [
    {
      section: "Pengalaman",
      before: "Bertanggung jawab atas pekerjaan harian di divisi terkait.",
      after: "Mengelola pekerjaan operasional divisi dengan fokus pada penyelesaian target, koordinasi tim, dan pelaporan hasil kerja secara berkala.",
    },
  ];
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => ({
    section: text(item?.section, "Bagian CV"),
    before: text(item?.before, "Kalimat sebelum tidak tersedia."),
    after: text(item?.after, "Versi perbaikan belum tersedia."),
  })).slice(0, 8);
  return items.length ? items : fallback;
}

module.exports = {
  ProviderError,
  callAIWithFallback,
  getProviderConfig,
  getProviders,
  buildSystemInstruction,
  buildUserPrompt,
  getDefaultReviewPrompt,
  parseModelJSON,
  normalizeReview,
};
