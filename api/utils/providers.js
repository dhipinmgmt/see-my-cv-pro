const DEFAULT_TIMEOUT_MS  = 55_000;
const MAX_MODEL_OUTPUT_TOKENS = 4000;

// ── Provider Error ────────────────────────────────────────────────────────────
class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name        = "ProviderError";
    this.provider    = options.provider    || "unknown";
    this.status      = options.status      || 500;
    this.code        = options.code        || "PROVIDER_ERROR";
    this.isRateLimit = Boolean(options.isRateLimit);
    this.isRetryable = Boolean(options.isRetryable);
    this.details     = options.details     || null;
  }
}

// ── Env helpers ───────────────────────────────────────────────────────────────
function getEnv(name, fallback = "") {
  return process.env[name] && String(process.env[name]).trim()
    ? String(process.env[name]).trim()
    : fallback;
}

function getProviderConfig() {
  // Multi-key Gemini setup.
  // GEMINI_API_KEY_1 → slot 1 (3.1 Pro) + slot 3 (3 Flash)   — Account 1
  // GEMINI_API_KEY_2 → slot 2 (2.5 Pro) + slot 4 (2.5 Flash) — Account 2
  // Both fall back to GEMINI_API_KEY for backward compatibility with single-key deployments.
  const key1 = getEnv("GEMINI_API_KEY_1") || getEnv("GEMINI_API_KEY");
  const key2 = getEnv("GEMINI_API_KEY_2") || getEnv("GEMINI_API_KEY");

  return {
    gemini_31_pro:   { apiKey: key1, model: getEnv("GEMINI_31_PRO_MODEL",   "gemini-3.1-pro-preview") },
    gemini_25_pro:   { apiKey: key2, model: getEnv("GEMINI_25_PRO_MODEL",   "gemini-2.5-pro") },
    gemini_3_flash:  { apiKey: key1, model: getEnv("GEMINI_3_FLASH_MODEL",  "gemini-3-flash-preview") },
    gemini_25_flash: { apiKey: key2, model: getEnv("GEMINI_25_FLASH_MODEL", "gemini-2.5-flash") },
    groq:        { apiKey: getEnv("GROQ_API_KEY"),        model: getEnv("GROQ_MODEL",        "llama-3.3-70b-versatile") },
    mistral:     { apiKey: getEnv("MISTRAL_API_KEY"),     model: getEnv("MISTRAL_MODEL",     "mistral-small-latest") },
    cohere:      { apiKey: getEnv("COHERE_API_KEY"),      model: getEnv("COHERE_MODEL",      "command-r") },
    huggingface: { apiKey: getEnv("HUGGINGFACE_API_KEY"), model: getEnv("HUGGINGFACE_MODEL", "Qwen/Qwen2.5-72B-Instruct") },
  };
}

// ── Language detection ────────────────────────────────────────────────────────
/**
 * Detects the dominant language of the CV text.
 * Samples the first 4 000 characters and counts word-level hits
 * against curated Indonesian and English word lists.
 * Returns "en" only when English clearly dominates; defaults to "id".
 */
function detectCVLanguage(text) {
  if (!text || text.length < 80) return "id";

  const sample = text.slice(0, 4000).toLowerCase();

  const ID_WORDS = new Set([
    "pengalaman","pendidikan","keahlian","keterampilan","pekerjaan",
    "perusahaan","jabatan","tanggung","jawab","riwayat","sarjana",
    "diploma","universitas","jurusan","lulusan","dan","dengan",
    "untuk","dalam","adalah","pada","yang","sebagai","telah",
    "dapat","kami","saya","kerja","proyek","bidang","divisi",
    "departemen","posisi","berhasil","meningkatkan","mengelola",
    "memimpin","mengembangkan","bertanggung","berkoordinasi",
    "mengoperasikan","menerapkan","merancang","membuat","melakukan",
    "tahun","bulan","sekolah","tinggi","institut","akademi",
  ]);

  const EN_WORDS = new Set([
    "experience","education","skills","work","company","position",
    "responsibilities","summary","objective","bachelor","degree",
    "university","managed","developed","achieved","proficient",
    "seeking","references","team","projects","leadership","resulted",
    "increased","reduced","delivered","collaborated","implemented",
    "designed","built","created","led","the","and","with","for",
    "have","has","been","years","months","graduated","certified",
    "responsible","coordinated","communicated","analyzed","improved",
  ]);

  const words = sample.match(/[a-z]{3,}/g) || [];
  let idCount = 0;
  let enCount = 0;

  for (const w of words) {
    if (ID_WORDS.has(w)) idCount++;
    if (EN_WORDS.has(w)) enCount++;
  }

  // Require English to clearly dominate (1.6× threshold) before switching
  return enCount > idCount * 1.6 ? "en" : "id";
}

// ── System instruction ────────────────────────────────────────────────────────
function buildSystemInstruction(language = "id") {
  const isEn = language === "en";

  const base = isEn
    ? [
        "You are a HR Professional and talent acquisition specialist with 15+ years of experience across multiple industries.",
        "Your task is to deliver a rigorous, honest, and deeply specific CV review — not generic advice.",
        "Evaluate this CV exactly as an HR Professional would: based on the target role, experience level, industry context, and the provided job description.",
        "Every feedback item MUST cite specific evidence from the actual CV text — job titles, company names, bullet points, skills listed, or sections present.",
        "NEVER write feedback that could apply to any CV. If you mention 'lacks quantified results', you MUST name the specific role or bullet point that lacks it.",
        "NEVER fabricate job titles, companies, achievements, tools, certifications, or numbers not present in the CV.",
        "If a section is missing entirely, state clearly that it is absent and explain the impact on shortlisting.",
        "Avoid hollow praise. Every positive observation must reference a specific CV element.",
        "Do NOT repeat the same issue across different output fields without adding new specifics each time.",
        "rewriteExamples MUST use actual sentences or phrases extracted directly from the CV — never write fictional before/after pairs.",
        "Respond ONLY with valid JSON — no markdown, no code fences, no commentary outside the JSON object.",
      ]
    : [
        "Anda adalah HR Professional dan spesialis rekrutmen dengan pengalaman 15+ tahun di berbagai industri.",
        "Tugas Anda adalah memberikan review CV yang ketat, jujur, dan sangat spesifik — bukan saran generik.",
        "Nilai CV ini persis seperti HR Professional menilainya: berdasarkan target posisi, level pengalaman, konteks industri, dan job description yang diberikan.",
        "Setiap poin feedback HARUS menyebut bukti spesifik dari isi CV aktual — jabatan, nama perusahaan, bullet point, skill yang tercantum, atau bagian yang ada/tidak ada.",
        "JANGAN menulis feedback yang bisa berlaku untuk CV siapapun. Jika Anda menyebut 'tidak ada pencapaian terukur', HARUS sebutkan peran atau bullet point spesifik yang dimaksud.",
        "JANGAN mengarang jabatan, perusahaan, pencapaian, tools, sertifikasi, atau angka yang tidak ada dalam CV.",
        "Jika suatu bagian sama sekali tidak ada di CV, nyatakan dengan jelas bahwa bagian itu tidak ditemukan dan jelaskan dampaknya.",
        "Hindari pujian kosong. Setiap penilaian positif harus merujuk elemen CV yang spesifik.",
        "JANGAN mengulang masalah yang sama di field output berbeda tanpa menambahkan detail baru.",
        "rewriteExamples HARUS menggunakan kalimat atau frasa yang benar-benar diambil dari CV — jangan buat pasangan before/after yang fiktif.",
        "Balas HANYA dengan JSON valid — tanpa markdown, tanpa code fence, tanpa teks apapun di luar objek JSON.",
      ];

  return base.join(" ");
}

// ── Default review prompt ─────────────────────────────────────────────────────
function getDefaultReviewPrompt(language = "id") {
  const isEn = language === "en";

  // ── Language output rule (injected at top of prompt) ─────────────────────
  const langRule = isEn
    ? `OUTPUT LANGUAGE: This CV is written in English. Write ALL review content in English — analysis, feedback, summaries, rewrite examples, and recommendations.\n\n`
    : `OUTPUT LANGUAGE: CV ini ditulis dalam Bahasa Indonesia. Tulis SELURUH konten review dalam Bahasa Indonesia — analisis, feedback, ringkasan, contoh rewrite, dan rekomendasi.\n\n`;

  // ── Review mode guidance ──────────────────────────────────────────────────
  const modeGuide = isEn
    ? `Review modes:
- balanced: critical but constructive, highlight both strengths and gaps.
- senior_hr: firm, direct, and objective — exactly how an HR Professional would annotate a CV.
- strict: harder, faster to reject; expose every weak point with no softening.
- rejection_risk: laser-focused on reasons a recruiter would skip this CV.\n\n`
    : `Mode review:
- balanced: kritis tapi konstruktif, soroti kekuatan dan kesenjangan.
- senior_hr: tegas, langsung, dan objektif — persis seperti HR Professional memberi catatan pada CV.
- strict: lebih keras, cepat menolak; ungkap setiap titik lemah tanpa melunak.
- rejection_risk: fokus laser pada alasan recruiter akan melewati CV ini.\n\n`;

  // ── Specificity enforcement ───────────────────────────────────────────────
  const specificityRules = isEn
    ? `SPECIFICITY RULES (mandatory — violations lower review quality):
1. Cite the actual role title, company name, or section name when discussing a specific part of the CV.
2. When the CV DOES contain quantified achievements, acknowledge them by name. When it DOES NOT, cite the specific bullet that would benefit most from quantification.
3. dimensionScore notes must reference a concrete element from the CV (e.g., "The bullet under [Role] at [Company] reads as task-focused rather than result-focused").
4. sectionReviews feedback must be grounded in the actual content of that section — mention what IS there, not just what is missing.
5. rewriteExamples: the "before" field must be an actual sentence or clause taken verbatim (or near-verbatim) from the CV. The "after" field must improve that exact sentence.
6. Do NOT use placeholder language like "e.g., add metrics" — always show the specific metric or phrasing that fits this candidate's actual context.\n\n`
    : `ATURAN SPESIFISITAS (wajib — pelanggaran menurunkan kualitas review):
1. Sebutkan nama jabatan, nama perusahaan, atau nama bagian CV yang spesifik saat membahas bagian tertentu.
2. Jika CV MEMANG memiliki pencapaian terukur, akui secara spesifik. Jika TIDAK, sebutkan bullet point mana yang paling perlu ditambahkan angka/hasil.
3. Catatan dimensionScore harus merujuk elemen konkret dari CV (mis. "Bullet pada peran [Jabatan] di [Perusahaan] terkesan deskripsi tugas, bukan hasil kerja").
4. Feedback sectionReviews harus didasarkan pada isi aktual bagian itu — sebut apa yang ADA, bukan hanya apa yang kurang.
5. rewriteExamples: field "before" HARUS berupa kalimat atau klausa yang benar-benar diambil dari CV (verbatim atau hampir verbatim). Field "after" harus memperbaiki kalimat tersebut.
6. JANGAN gunakan bahasa placeholder seperti "mis. tambahkan metrik" — selalu tunjukkan metrik atau frasa spesifik yang sesuai dengan konteks kandidat ini.\n\n`;

  // ── JSON schema ───────────────────────────────────────────────────────────
  const schema = isEn
    ? `Return ONLY valid JSON with exactly this structure:
{
  "score": 74,
  "summary": "2–4 sentences about the overall CV quality, referencing specific strengths and gaps found in this CV.",
  "verdict": "One clear, direct final verdict — name the biggest blocker or differentiator.",
  "seniorHrFirstImpression": "What a HR Professional thinks in the first 10 seconds — cite the first visible element (name block, headline, or top experience) that creates this impression.",
  "targetRoleFit": {
    "score": 70,
    "assessment": "Specific assessment of CV–role alignment. Reference the most relevant (or most misaligned) experience or skill found in the CV."
  },
  "dimensionScores": [
    { "name": "Role Alignment",        "score": 70, "note": "Cite specific role/skill evidence." },
    { "name": "Experience Impact",     "score": 65, "note": "Cite a specific bullet or role that illustrates the issue." },
    { "name": "Achievement Clarity",   "score": 60, "note": "Reference a specific bullet that lacks or demonstrates quantified results." },
    { "name": "Skills Relevance",      "score": 75, "note": "Name specific skills listed and their relevance to the target role." },
    { "name": "ATS Keyword Readiness", "score": 68, "note": "Mention specific missing or present keywords relative to the job description." },
    { "name": "Structure & Readability","score": 72, "note": "Comment on section order, bullet style, or length based on what is in this CV." },
    { "name": "Profile / Summary",     "score": 65, "note": "Evaluate the actual summary/objective text if present; note its absence if missing." },
    { "name": "Completeness",          "score": 70, "note": "Name any critical sections that are absent or thin in this CV." }
  ],
  "strengths": [
    "Strength 1 — must reference a specific section, role, skill, or phrase from the CV.",
    "Strength 2 — same rule.",
    "Strength 3 — same rule."
  ],
  "criticalWeaknesses": [
    "Weakness 1 — cite the specific element that is weak.",
    "Weakness 2 — cite the specific element that is weak.",
    "Weakness 3 — cite the specific element that is weak."
  ],
  "fatalMistakes": [
    "Fatal issue 1 — must be backed by something actually in (or missing from) this CV.",
    "Fatal issue 2 — same rule."
  ],
  "rejectionRisks": [
    "Risk 1 — what specific signal will make a recruiter skip this CV.",
    "Risk 2 — same rule.",
    "Risk 3 — same rule."
  ],
  "recommendations": [
    "Actionable recommendation 1 — specific to this CV's actual content.",
    "Actionable recommendation 2.",
    "Actionable recommendation 3.",
    "Actionable recommendation 4."
  ],
  "priorityFixes": [
    {
      "priority": 1,
      "issue": "Name the exact problem — reference the CV section or bullet.",
      "action": "Precise corrective action — show what to write or change, not just what category to improve.",
      "impact": "Very High"
    },
    {
      "priority": 2,
      "issue": "Second most important problem.",
      "action": "Precise corrective action.",
      "impact": "High"
    },
    {
      "priority": 3,
      "issue": "Third most important problem.",
      "action": "Precise corrective action.",
      "impact": "High"
    }
  ],
  "sectionReviews": [
    { "title": "Profile / Summary",    "score": 65, "feedback": "Evaluate actual summary content — quote a phrase if possible." },
    { "title": "Work Experience",      "score": 70, "feedback": "Comment on the most recent role's bullet quality and relevance." },
    { "title": "Skills",               "score": 72, "feedback": "Name specific skills listed and assess their match with the target role." },
    { "title": "Education",            "score": 75, "feedback": "Note degree, institution, and any missing expected credentials for the target role." },
    { "title": "Format & ATS",         "score": 68, "feedback": "Comment on layout, file type, readability, and ATS-parse risk based on this CV." }
  ],
  "rewriteExamples": [
    {
      "section": "Work Experience",
      "before": "ACTUAL sentence or bullet from the CV — verbatim or very close.",
      "after": "Improved version of that exact sentence — stronger, more result-oriented, ATS-friendly."
    },
    {
      "section": "Profile / Summary",
      "before": "ACTUAL opening phrase or summary sentence from the CV.",
      "after": "Rewritten version that is sharper, role-specific, and keyword-rich."
    }
  ]
}`
    : `Kembalikan HANYA JSON valid dengan struktur tepat seperti ini:
{
  "score": 74,
  "summary": "2–4 kalimat tentang kualitas CV secara keseluruhan, merujuk kekuatan dan kesenjangan spesifik yang ditemukan di CV ini.",
  "verdict": "Satu final verdict yang jelas dan langsung — sebut hambatan terbesar atau pembeda utama.",
  "seniorHrFirstImpression": "Apa yang dipikirkan HR Professional dalam 10 detik pertama — sebutkan elemen pertama yang terlihat (blok nama, headline, atau pengalaman teratas) yang menciptakan kesan ini.",
  "targetRoleFit": {
    "score": 70,
    "assessment": "Penilaian spesifik tentang keselarasan CV dengan target posisi. Rujuk pengalaman atau skill yang paling relevan atau paling tidak selaras yang ditemukan di CV."
  },
  "dimensionScores": [
    { "name": "Kesesuaian dengan Target Posisi", "score": 70, "note": "Sebutkan bukti peran/skill yang spesifik." },
    { "name": "Dampak Pengalaman Kerja",         "score": 65, "note": "Sebutkan bullet atau peran spesifik yang menggambarkan masalah." },
    { "name": "Kejelasan Pencapaian",            "score": 60, "note": "Rujuk bullet spesifik yang kurang atau mendemonstrasikan hasil terukur." },
    { "name": "Relevansi Skill & Tools",         "score": 75, "note": "Sebutkan skill spesifik yang tercantum dan relevansinya dengan target posisi." },
    { "name": "Kesiapan Keyword ATS",            "score": 68, "note": "Sebutkan keyword yang spesifik hilang atau sudah ada relatif terhadap job description." },
    { "name": "Struktur & Keterbacaan",          "score": 72, "note": "Komentari urutan seksi, gaya bullet, atau panjang berdasarkan isi CV ini." },
    { "name": "Kualitas Profil / Ringkasan",     "score": 65, "note": "Evaluasi teks summary/objective aktual jika ada; catat ketidakhadirannya jika tidak ada." },
    { "name": "Kelengkapan Informasi",           "score": 70, "note": "Sebutkan seksi kritis yang tidak ada atau tipis di CV ini." }
  ],
  "strengths": [
    "Kekuatan 1 — harus merujuk seksi, peran, skill, atau frasa spesifik dari CV.",
    "Kekuatan 2 — aturan yang sama.",
    "Kekuatan 3 — aturan yang sama."
  ],
  "criticalWeaknesses": [
    "Kelemahan 1 — sebutkan elemen spesifik yang lemah.",
    "Kelemahan 2 — sebutkan elemen spesifik yang lemah.",
    "Kelemahan 3 — sebutkan elemen spesifik yang lemah."
  ],
  "fatalMistakes": [
    "Masalah fatal 1 — harus didukung oleh sesuatu yang ada atau tidak ada di CV ini.",
    "Masalah fatal 2 — aturan yang sama."
  ],
  "rejectionRisks": [
    "Risiko 1 — sinyal spesifik apa yang akan membuat recruiter melewati CV ini.",
    "Risiko 2 — aturan yang sama.",
    "Risiko 3 — aturan yang sama."
  ],
  "recommendations": [
    "Rekomendasi yang dapat ditindaklanjuti 1 — spesifik untuk konten aktual CV ini.",
    "Rekomendasi 2.",
    "Rekomendasi 3.",
    "Rekomendasi 4."
  ],
  "priorityFixes": [
    {
      "priority": 1,
      "issue": "Sebutkan masalah yang tepat — rujuk seksi atau bullet CV.",
      "action": "Tindakan korektif yang presisi — tunjukkan apa yang harus ditulis atau diubah, bukan hanya kategori yang perlu diperbaiki.",
      "impact": "Sangat Tinggi"
    },
    {
      "priority": 2,
      "issue": "Masalah terpenting kedua.",
      "action": "Tindakan korektif yang presisi.",
      "impact": "Tinggi"
    },
    {
      "priority": 3,
      "issue": "Masalah terpenting ketiga.",
      "action": "Tindakan korektif yang presisi.",
      "impact": "Tinggi"
    }
  ],
  "sectionReviews": [
    { "title": "Profil / Ringkasan",    "score": 65, "feedback": "Evaluasi konten summary aktual — kutip frasa jika memungkinkan." },
    { "title": "Pengalaman Kerja",      "score": 70, "feedback": "Komentari kualitas bullet peran terbaru dan relevansinya." },
    { "title": "Skill",                 "score": 72, "feedback": "Sebutkan skill spesifik yang tercantum dan nilai kecocokannya dengan target posisi." },
    { "title": "Pendidikan",            "score": 75, "feedback": "Catat gelar, institusi, dan kredensial yang diharapkan untuk target posisi." },
    { "title": "Format & ATS",          "score": 68, "feedback": "Komentari tata letak, keterbacaan, dan risiko parse ATS berdasarkan CV ini." }
  ],
  "rewriteExamples": [
    {
      "section": "Pengalaman Kerja",
      "before": "Kalimat atau bullet AKTUAL dari CV — verbatim atau sangat dekat.",
      "after": "Versi perbaikan dari kalimat tersebut — lebih kuat, berorientasi hasil, ramah ATS."
    },
    {
      "section": "Profil / Ringkasan",
      "before": "Frasa pembuka atau kalimat summary AKTUAL dari CV.",
      "after": "Versi yang ditulis ulang — lebih tajam, spesifik terhadap peran, dan kaya keyword."
    }
  ]
}`;

  // ── Closing rules ─────────────────────────────────────────────────────────
  const closingRules = isEn
    ? `\n\nFINAL RULES:
- score values must be integers 0–100. Reflect real quality differences — avoid clustering all scores at 60–70.
- dimensionScores: exactly 8 items.
- strengths: 3–6 items. Each must be specific to this CV.
- criticalWeaknesses: 3–6 items. Each must cite a specific CV element.
- fatalMistakes: 2–5 items. If no truly fatal mistakes, name the highest-risk issues with full specifics.
- rejectionRisks: 3–6 items.
- recommendations: 4–8 items. Each must be actionable for THIS candidate, not generic advice.
- priorityFixes: 3–6 items sorted by impact descending.
- sectionReviews: 4–7 items covering sections actually present in the CV.
- rewriteExamples: 2–5 items. ONLY use actual CV text in "before". Never fabricate.
- Do NOT identify yourself as an AI.
- If the target role clearly does not match the CV content, state this explicitly with supporting evidence.`
    : `\n\nATURAN AKHIR:
- Nilai score harus integer 0–100. Cerminkan perbedaan kualitas nyata — hindari mengelompokkan semua skor di 60–70.
- dimensionScores: tepat 8 item.
- strengths: 3–6 item. Masing-masing harus spesifik untuk CV ini.
- criticalWeaknesses: 3–6 item. Masing-masing harus menyebut elemen CV spesifik.
- fatalMistakes: 2–5 item. Jika tidak ada kesalahan yang benar-benar fatal, sebutkan masalah berisiko tertinggi dengan detail penuh.
- rejectionRisks: 3–6 item.
- recommendations: 4–8 item. Masing-masing harus dapat ditindaklanjuti untuk kandidat INI, bukan saran generik.
- priorityFixes: 3–6 item, diurutkan berdasarkan dampak tertinggi ke terendah.
- sectionReviews: 4–7 item, mencakup bagian yang benar-benar ada di CV.
- rewriteExamples: 2–5 item. HANYA gunakan teks CV aktual di "before". Jangan mengarang.
- JANGAN mengidentifikasi diri Anda sebagai AI.
- Jika target posisi jelas tidak cocok dengan isi CV, nyatakan secara eksplisit beserta bukti pendukungnya.`;

  return langRule + modeGuide + specificityRules + schema + closingRules;
}

// ── User prompt builder ───────────────────────────────────────────────────────
function buildUserPrompt({ prompt, extractedText, fileMetadata, careerContext, language }) {
  const lang = language || "id";
  const isEn = lang === "en";

  const langNote = isEn
    ? `Detected CV language: English. Write all review output in English.`
    : `Bahasa CV yang terdeteksi: Indonesia. Tulis seluruh output review dalam Bahasa Indonesia.`;

  const contextLabel     = isEn ? "Career context"  : "Konteks target karier";
  const metaLabel        = isEn ? "File metadata"   : "Metadata file";
  const cvLabel          = isEn ? "Extracted CV text" : "Teks CV yang diekstrak";

  return [
    prompt || getDefaultReviewPrompt(lang),
    "",
    `[${langNote}]`,
    "",
    `${contextLabel}:`,
    JSON.stringify(careerContext || {}, null, 2),
    "",
    `${metaLabel}:`,
    JSON.stringify(fileMetadata || {}, null, 2),
    "",
    `${cvLabel}:`,
    extractedText,
  ].join("\n");
}

// ── Provider registry ─────────────────────────────────────────────────────────
function getProviders() {
  const config = getProviderConfig();
  return [
    // ── Gemini models — priority order: best reasoning first, Flash as fallback ──
    { name: "Google Gemini 3.1 Pro",   model: config.gemini_31_pro.model,   enabled: Boolean(config.gemini_31_pro.apiKey),   call: (input) => callGemini(input, config.gemini_31_pro) },
    { name: "Google Gemini 2.5 Pro",   model: config.gemini_25_pro.model,   enabled: Boolean(config.gemini_25_pro.apiKey),   call: (input) => callGemini(input, config.gemini_25_pro) },
    { name: "Google Gemini 3 Flash",   model: config.gemini_3_flash.model,  enabled: Boolean(config.gemini_3_flash.apiKey),  call: (input) => callGemini(input, config.gemini_3_flash) },
    { name: "Google Gemini 2.5 Flash", model: config.gemini_25_flash.model, enabled: Boolean(config.gemini_25_flash.apiKey), call: (input) => callGemini(input, config.gemini_25_flash) },
    // ── Non-Gemini backups — only triggered when all Gemini quota is exhausted ──
    { name: "Groq",                    model: config.groq.model,            enabled: Boolean(config.groq.apiKey),            call: (input) => callGroq(input, config.groq) },
    { name: "Mistral AI",              model: config.mistral.model,         enabled: Boolean(config.mistral.apiKey),         call: (input) => callMistral(input, config.mistral) },
    { name: "Cohere",                  model: config.cohere.model,          enabled: Boolean(config.cohere.apiKey),          call: (input) => callCohere(input, config.cohere) },
    { name: "Hugging Face Inference",  model: config.huggingface.model,     enabled: Boolean(config.huggingface.apiKey),     call: (input) => callHuggingFace(input, config.huggingface) },
  ];
}

// ── Fallback orchestrator ─────────────────────────────────────────────────────
async function callAIWithFallback({ prompt, extractedText, fileMetadata, careerContext }) {
  const providers        = getProviders();
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

  // Detect language once; reuse across all provider attempts
  const language = detectCVLanguage(extractedText || "");

  const input = {
    systemInstruction: buildSystemInstruction(language),
    userPrompt: buildUserPrompt({ prompt, extractedText, fileMetadata, careerContext, language }),
  };

  const failures = [];

  for (const provider of enabledProviders) {
    try {
      const rawText = await provider.call(input);
      const parsed  = parseModelJSON(rawText);
      return {
        review:               normalizeReview(parsed),
        usedProvider:         provider.name,
        usedModel:            provider.model,
        detectedLanguage:     language,
        rawText,
        attemptedProviders:   enabledProviders.map((p) => p.name),
        skippedProviders,
      };
    } catch (error) {
      const normalized = normalizeProviderError(error, provider.name);
      failures.push({
        provider:    provider.name,
        model:       provider.model,
        status:      normalized.status,
        code:        normalized.code,
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

// ── Provider call implementations ─────────────────────────────────────────────
async function callGemini(input, config) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const response = await fetchJSON(endpoint, {
    provider: "Google Gemini",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
      generationConfig: {
        temperature: 0.28,
        topP: 0.92,
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
      temperature: 0.28,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user",   content: input.userPrompt },
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
      temperature: 0.28,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user",   content: input.userPrompt },
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
      temperature: 0.28,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user",   content: input.userPrompt },
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
      temperature: 0.28,
      max_tokens: MAX_MODEL_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: input.systemInstruction },
        { role: "user",   content: input.userPrompt },
      ],
    }),
  });
  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) throw emptyResponse("Hugging Face Inference");
  return text;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function emptyResponse(provider) {
  return new ProviderError(`${provider} tidak mengembalikan teks review.`, {
    provider,
    status: 502,
    code: "EMPTY_MODEL_RESPONSE",
    isRetryable: true,
  });
}

async function fetchJSON(url, options = {}) {
  const provider   = options.provider || "AI Provider";
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method:  "POST",
      headers: options.headers || {},
      body:    options.body,
      signal:  controller.signal,
    });

    const payload = await safeReadJSON(response);

    if (!response.ok) {
      throw new ProviderError(`Provider ${provider} gagal memproses permintaan.`, {
        provider,
        status:      response.status,
        code:        getProviderErrorCode(response.status, payload),
        isRateLimit: isRateLimitStatus(response.status, payload),
        isRetryable: isRetryableStatus(response.status),
        details:     sanitizeProviderDetails(payload),
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
  if (status === 408)                   return "PROVIDER_TIMEOUT";
  if (status === 429)                   return "PROVIDER_RATE_LIMIT";
  if (status >= 500)                    return "PROVIDER_SERVER_ERROR";
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

// ── JSON parser ───────────────────────────────────────────────────────────────
function parseModelJSON(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new ProviderError("Respons AI kosong.", {
      provider: "parser", status: 502, code: "EMPTY_MODEL_RESPONSE", isRetryable: true,
    });
  }

  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last  = cleaned.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      throw new ProviderError("Respons AI bukan JSON valid.", {
        provider: "parser", status: 502, code: "INVALID_JSON_RESPONSE", isRetryable: true,
      });
    }
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (error) {
      throw new ProviderError("JSON dari AI gagal diparse.", {
        provider: "parser", status: 502, code: "JSON_PARSE_FAILED",
        isRetryable: true, details: error?.message || null,
      });
    }
  }
}

// ── Review normalizer ─────────────────────────────────────────────────────────
function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 60;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function text(value, fallback) {
  return typeof value === "string" && value.trim()
    ? value.replace(/\s+/g, " ").trim()
    : fallback;
}

function list(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => text(item, "")).filter(Boolean).slice(0, 12);
  return items.length ? items : fallback;
}

function normalizeReview(review = {}) {
  return {
    score:                   clampScore(review.score),
    summary:                 text(review.summary,                 "CV berhasil dianalisis. Lihat detail tiap dimensi untuk panduan perbaikan."),
    verdict:                 text(review.verdict,                 "CV ini memiliki potensi tetapi masih perlu diperkuat agar kompetitif."),
    seniorHrFirstImpression: text(review.seniorHrFirstImpression, "Dalam 10 detik pertama, CV belum cukup kuat menunjukkan value utama kandidat."),
    targetRoleFit: {
      score:      clampScore(review.targetRoleFit?.score),
      assessment: text(review.targetRoleFit?.assessment, "Kesesuaian dengan target posisi perlu diperjelas dengan pengalaman dan skill yang lebih relevan."),
    },
    dimensionScores:    normalizeDimensionScores(review.dimensionScores),
    strengths:          list(review.strengths,          ["CV sudah memiliki fondasi dasar yang dapat dikembangkan."]),
    criticalWeaknesses: list(review.criticalWeaknesses || review.weaknesses, ["Beberapa bagian CV masih terlalu umum dan belum menunjukkan dampak kerja."]),
    fatalMistakes:      list(review.fatalMistakes,      ["CV belum menunjukkan pencapaian terukur yang cukup kuat untuk bersaing."]),
    rejectionRisks:     list(review.rejectionRisks,     ["Recruiter dapat menilai CV ini kurang kompetitif karena bukti hasil kerja belum spesifik."]),
    recommendations:    list(review.recommendations,    ["Tambahkan pencapaian terukur, keyword relevan, dan perkuat profil singkat."]),
    priorityFixes:      normalizePriorityFixes(review.priorityFixes),
    sectionReviews:     normalizeSectionReviews(review.sectionReviews),
    rewriteExamples:    normalizeRewriteExamples(review.rewriteExamples),
  };
}

function normalizeDimensionScores(value) {
  const fallback = [
    { name: "Kesesuaian dengan Target Posisi", score: 60, note: "CV perlu lebih menonjolkan pengalaman dan skill yang sesuai target posisi." },
    { name: "Dampak Pengalaman Kerja",         score: 60, note: "Pengalaman perlu dibuat lebih berbasis hasil, bukan sekadar deskripsi tugas." },
    { name: "Kejelasan Pencapaian",            score: 55, note: "Pencapaian terukur masih perlu diperkuat dengan angka dan konteks." },
    { name: "Relevansi Skill & Tools",         score: 60, note: "Skill perlu disusun sesuai kebutuhan posisi dan diperkuat keyword relevan." },
    { name: "Kesiapan Keyword ATS",            score: 60, note: "Keyword penting perlu ditambahkan secara natural berdasarkan job description." },
    { name: "Struktur & Keterbacaan",          score: 65, note: "Struktur perlu dibuat lebih ringkas dan mudah discan oleh recruiter." },
    { name: "Kualitas Profil / Ringkasan",     score: 58, note: "Profil singkat perlu menunjukkan value proposition yang lebih tajam." },
    { name: "Kelengkapan Informasi",           score: 62, note: "Beberapa bagian penting perlu dilengkapi agar tidak memunculkan pertanyaan." },
  ];

  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => ({
    name:  text(item?.name,  "Dimensi penilaian"),
    score: clampScore(item?.score),
    note:  text(item?.note,  "Belum ada catatan."),
  })).filter((item) => item.name).slice(0, 10);
  return items.length ? items : fallback;
}

function normalizePriorityFixes(value) {
  const fallback = [
    { priority: 1, issue: "Profil singkat belum cukup tajam dan tidak menunjukkan value utama kandidat.", action: "Tulis ulang profil dengan menyebut target role secara eksplisit, 2–3 skill utama, dan satu pencapaian atau nilai profesional yang paling relevan.", impact: "Sangat Tinggi" },
    { priority: 2, issue: "Bullet pengalaman kerja bersifat deskripsi tugas, bukan pencapaian.", action: "Ubah setiap bullet menjadi format 'Tindakan + Hasil + Dampak' dan tambahkan angka, persentase, atau skala jika memungkinkan.", impact: "Sangat Tinggi" },
    { priority: 3, issue: "Keyword target posisi belum terdeteksi secara konsisten di seluruh CV.", action: "Identifikasi 5–8 keyword utama dari job description target, lalu masukkan secara natural ke seksi Profil, Pengalaman, dan Skill.", impact: "Tinggi" },
  ];
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item, index) => ({
    priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : index + 1,
    issue:    text(item?.issue,  "Masalah prioritas"),
    action:   text(item?.action, "Tindakan perbaikan belum tersedia."),
    impact:   text(item?.impact, "Sedang"),
  })).slice(0, 8);
  return items.length ? items : fallback;
}

function normalizeSectionReviews(value) {
  const fallback = [
    { title: "Struktur CV",                   score: 60, feedback: "Struktur CV perlu dibuat lebih konsisten agar informasi utama mudah discan." },
    { title: "Pengalaman dan Pencapaian",      score: 60, feedback: "Pengalaman perlu dilengkapi dampak kerja nyata, angka, atau hasil terukur yang spesifik." },
    { title: "Skill dan Kata Kunci",           score: 60, feedback: "Skill perlu disusun sesuai posisi tujuan dan diperkuat dengan keyword ATS yang relevan." },
  ];
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => ({
    title:    text(item?.title,    "Bagian CV"),
    score:    clampScore(item?.score),
    feedback: text(item?.feedback, "Bagian ini perlu diperjelas agar lebih kuat dan relevan."),
  })).slice(0, 12);
  return items.length ? items : fallback;
}

function normalizeRewriteExamples(value) {
  const fallback = [
    {
      section: "Pengalaman Kerja",
      before:  "Bertanggung jawab atas pekerjaan harian di divisi terkait.",
      after:   "Memimpin operasional harian divisi [nama divisi] dengan mengoordinasikan [X] anggota tim, menghasilkan [pencapaian spesifik] dalam [periode waktu].",
    },
  ];
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => ({
    section: text(item?.section, "Bagian CV"),
    before:  text(item?.before,  "Kalimat sebelum tidak tersedia."),
    after:   text(item?.after,   "Versi perbaikan belum tersedia."),
  })).slice(0, 8);
  return items.length ? items : fallback;
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  ProviderError,
  callAIWithFallback,
  getProviderConfig,
  getProviders,
  buildSystemInstruction,
  buildUserPrompt,
  getDefaultReviewPrompt,
  detectCVLanguage,
  parseModelJSON,
  normalizeReview,
};
