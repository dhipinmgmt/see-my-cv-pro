const { callAIWithFallback, ProviderError } = require("./utils/providers");

const MAX_TEXT_LENGTH = 60_000;
const MIN_TEXT_LENGTH = 120;
const MAX_BODY_LENGTH = 220_000;
const DEFAULT_RATE_LIMIT = 12;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

// ── Disable Vercel's automatic body parsing so we can enforce
//    MAX_BODY_LENGTH ourselves before touching the payload.
module.exports.config = {
  api: { bodyParser: false },
};

// ── Read raw body from the Node.js IncomingMessage stream ──────────────────
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Response helper (mirrors the old jsonResponse, but uses res directly) ──
function sendJSON(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res
    .status(statusCode)
    .set({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      ...extraHeaders,
    })
    .end(body);
}

// ── Header helper (case-insensitive, works with both Netlify and Vercel) ───
function getHeader(headers = {}, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry ? entry[1] : "";
}

// ── CORS ────────────────────────────────────────────────────────────────────
function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function isOriginAllowed(req) {
  const allowedOrigins = getAllowedOrigins();
  if (!allowedOrigins.length) return true;
  const origin = getHeader(req.headers, "origin");
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function getCORSHeaders(req) {
  const origin = getHeader(req.headers, "origin");
  const allowedOrigins = getAllowedOrigins();
  if (!origin || !allowedOrigins.length || !allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

// ── Request validation ───────────────────────────────────────────────────────
function createRequestError(message, statusCode = 400, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parseRequestBody(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw createRequestError("Body request harus berupa JSON valid.", 400, "INVALID_JSON_BODY");
  }
}

function sanitizeText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\u0000/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{5,}/g, "\n\n\n")
    .trim();
}

function sanitizeString(value, fallback, maxLength) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function sanitizeFileMetadata(meta = {}) {
  if (!meta || typeof meta !== "object") {
    return { name: "cv", type: "unknown", size: 0, extension: "" };
  }
  return {
    name:      sanitizeString(meta.name,      "cv",      180),
    type:      sanitizeString(meta.type,      "unknown", 80),
    size:      Number.isFinite(Number(meta.size)) ? Number(meta.size) : 0,
    extension: sanitizeString(meta.extension, "",        16).replace(/[^a-z0-9.]/gi, ""),
  };
}

function sanitizeReviewMode(value) {
  const safe = sanitizeString(value, "senior_hr", 40);
  return new Set(["balanced", "senior_hr", "strict", "rejection_risk"]).has(safe)
    ? safe
    : "senior_hr";
}

function sanitizeCareerContext(context = {}) {
  if (!context || typeof context !== "object") {
    return { targetRole: "", industry: "", experienceLevel: "Junior", reviewMode: "senior_hr", jobDescription: "" };
  }
  return {
    targetRole:      sanitizeString(context.targetRole,      "", 140),
    industry:        sanitizeString(context.industry,        "", 120),
    experienceLevel: sanitizeString(context.experienceLevel, "Junior", 80),
    reviewMode:      sanitizeReviewMode(context.reviewMode),
    jobDescription:  sanitizeString(context.jobDescription,  "", 12_000),
  };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw createRequestError("Payload request tidak valid.", 400, "INVALID_PAYLOAD");
  }

  const extractedText = sanitizeText(payload.extractedText);
  if (!extractedText) {
    throw createRequestError("Teks CV kosong atau tidak ditemukan.", 400, "EMPTY_EXTRACTED_TEXT");
  }
  if (extractedText.length < MIN_TEXT_LENGTH) {
    throw createRequestError(
      "Teks CV terlalu pendek untuk dianalisis. Pastikan file berisi konten CV yang dapat dibaca.",
      400, "TEXT_TOO_SHORT"
    );
  }
  if (extractedText.length > MAX_TEXT_LENGTH) {
    throw createRequestError("Teks CV terlalu panjang untuk diproses.", 413, "TEXT_TOO_LONG");
  }

  const fileMetadata  = sanitizeFileMetadata(payload.fileMetadata);
  const careerContext = sanitizeCareerContext(payload.careerContext);

  if (!careerContext.targetRole || careerContext.targetRole.length < 3) {
    throw createRequestError("Target posisi wajib diisi.", 400, "TARGET_ROLE_REQUIRED");
  }

  return { extractedText, fileMetadata, careerContext };
}

// ── Rate limiting (Upstash Redis — optional) ────────────────────────────────
function getClientIdentifier(req) {
  const forwardedFor = getHeader(req.headers, "x-forwarded-for");
  const realIp       = getHeader(req.headers, "x-real-ip");
  const ip = forwardedFor.split(",")[0]?.trim() || realIp || "anonymous";
  return ip.replace(/[^a-zA-Z0-9:._-]/g, "").slice(0, 80) || "anonymous";
}

async function checkRateLimit(req) {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token   = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!restUrl || !token) return { limited: false, remaining: null, limit: null };

  const limit         = Number(process.env.RATE_LIMIT_PER_MINUTE        || DEFAULT_RATE_LIMIT);
  const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS    || DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
  const key           = `see-my-cv:rate:${getClientIdentifier(req)}`;

  const incrementResponse = await upstashCommand(restUrl, token, ["INCR", key]);
  const count = Number(incrementResponse?.result || 0);

  if (count === 1) await upstashCommand(restUrl, token, ["EXPIRE", key, String(windowSeconds)]);

  return { limited: count > limit, remaining: Math.max(0, limit - count), limit };
}

async function upstashCommand(restUrl, token, command) {
  const response = await fetch(restUrl, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify(command),
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

// ── Error mapping ────────────────────────────────────────────────────────────
function safeDetails(details) {
  if (!details) return null;
  if (typeof details === "string") return details.slice(0, 500);
  if (typeof details === "object") {
    return JSON.parse(
      JSON.stringify(details, (key, value) =>
        typeof value === "string" ? value.slice(0, 500) : value
      )
    );
  }
  return null;
}

function mapErrorToResponse(error) {
  if (error instanceof ProviderError) {
    return {
      statusCode: error.status || 503,
      payload: {
        error:   "AI_PROVIDER_ERROR",
        code:    error.code,
        message: error.message,
        details: safeDetails(error.details),
      },
    };
  }
  return {
    statusCode: error.statusCode || 500,
    payload: {
      error:   error.code || "SERVER_ERROR",
      code:    error.code || "SERVER_ERROR",
      message: error.message || "Server gagal memproses review CV.",
    },
  };
}

// ── Main Vercel handler ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const corsHeaders = getCORSHeaders(req);

  // Preflight
  if (req.method === "OPTIONS") {
    return sendJSON(res, 204, {}, corsHeaders);
  }

  // Method guard
  if (req.method !== "POST") {
    return sendJSON(res, 405, {
      error:   "METHOD_NOT_ALLOWED",
      code:    "METHOD_NOT_ALLOWED",
      message: "Endpoint ini hanya menerima request POST.",
    }, { ...corsHeaders, Allow: "POST, OPTIONS" });
  }

  // Origin guard
  if (!isOriginAllowed(req)) {
    return sendJSON(res, 403, {
      error:   "FORBIDDEN_ORIGIN",
      code:    "FORBIDDEN_ORIGIN",
      message: "Origin request tidak diizinkan.",
    }, corsHeaders);
  }

  // Content-Type guard
  const contentType = getHeader(req.headers, "content-type");
  if (!contentType.toLowerCase().includes("application/json")) {
    return sendJSON(res, 415, {
      error:   "UNSUPPORTED_MEDIA_TYPE",
      code:    "UNSUPPORTED_MEDIA_TYPE",
      message: "Content-Type harus application/json.",
    }, corsHeaders);
  }

  try {
    // Rate limit check
    const rateLimit = await checkRateLimit(req);
    if (rateLimit.limited) {
      return sendJSON(res, 429, {
        error:   "RATE_LIMITED",
        code:    "RATE_LIMITED",
        message: "Terlalu banyak permintaan. Coba lagi beberapa saat lagi.",
      }, {
        ...corsHeaders,
        "X-RateLimit-Limit":     String(rateLimit.limit),
        "X-RateLimit-Remaining": String(rateLimit.remaining),
      });
    }

    // Read and validate body
    const rawBuffer = await readRawBody(req);
    if (rawBuffer.byteLength > MAX_BODY_LENGTH) {
      throw createRequestError("Payload terlalu besar.", 413, "PAYLOAD_TOO_LARGE");
    }

    const bodyPayload = parseRequestBody(rawBuffer.toString("utf8"));
    const { extractedText, fileMetadata, careerContext } = validatePayload(bodyPayload);

    // Call AI
    const aiResult = await callAIWithFallback({ extractedText, fileMetadata, careerContext });

    return sendJSON(res, 200, {
      review:       aiResult.review,
      usedProvider: aiResult.usedProvider,
      usedModel:    aiResult.usedModel,
      privacy: {
        persisted: false,
        message:   "Data CV diproses sementara dan tidak disimpan oleh aplikasi ini.",
      },
    }, corsHeaders);

  } catch (error) {
    const { statusCode, payload } = mapErrorToResponse(error);
    return sendJSON(res, statusCode, payload, corsHeaders);
  }
};
