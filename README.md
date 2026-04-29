# See My CV

Aplikasi web review CV menggunakan AI dengan pendekatan **Senior HR CV Audit**, arsitektur **static + serverless**, **multi-model fallback**, dan **zero persistence**.

## Fitur Utama

- Upload CV format PDF dan DOCX
- Parsing file di browser menggunakan pdf.js dan mammoth.js
- Review berbasis target posisi dan job description
- Mode review: Balanced, Senior HR, Strict HR, Rejection Risk
- Skor keseluruhan dan skor per dimensi
- Kesan recruiter dalam 10 detik pertama
- Kesalahan fatal dan risiko penolakan
- Prioritas perbaikan dan contoh rewrite kalimat CV
- Serverless API proxy untuk menjaga API key tetap aman
- Tanpa database, tanpa penyimpanan data CV

## Struktur Project

```
/
├── api/
│   ├── review.js               ← Vercel Serverless Function
│   └── utils/
│       └── providers.js        ← Multi-model AI fallback logic
├── public/
│   ├── index.html
│   ├── styles/
│   │   └── main.css
│   └── scripts/
│       ├── api.js
│       ├── fileParser.js
│       ├── main.js
│       └── ui.js
├── vercel.json
└── README.md
```

## Deploy ke Vercel

### Build Settings (Vercel Dashboard)

| Setting | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | *(kosong)* |
| Build Command | *(kosong)* |
| Output Directory | `public` |
| Install Command | *(kosong)* |

> Tidak perlu build command karena project ini static + serverless tanpa bundler.

### Environment Variables Minimal

```env
GEMINI_API_KEY="isi_api_key_anda"
GEMINI_MODEL="gemini-2.0-flash"
```

### Environment Variables Lengkap

```env
# AI Providers (minimal 1 wajib diisi)
GEMINI_API_KEY=""
GROQ_API_KEY=""
MISTRAL_API_KEY=""
COHERE_API_KEY=""
HUGGINGFACE_API_KEY=""

# Model overrides (opsional, sudah ada default)
GEMINI_MODEL="gemini-2.0-flash"
GROQ_MODEL="llama-3.3-70b-versatile"
MISTRAL_MODEL="mistral-small-latest"
COHERE_MODEL="command-r"
HUGGINGFACE_MODEL="Qwen/Qwen2.5-72B-Instruct"

# CORS (opsional — kosongkan saat testing, isi domain saat production)
ALLOWED_ORIGINS="https://nama-project.vercel.app"

# Rate limiting via Upstash Redis (opsional)
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""
RATE_LIMIT_PER_MINUTE="12"
RATE_LIMIT_WINDOW_SECONDS="60"
```

### Cara Deploy Pertama Kali

1. Push seluruh repository ke GitHub.
2. Buka [vercel.com](https://vercel.com) → **Add New Project**.
3. Import repository dari GitHub.
4. Set Framework Preset ke **Other**.
5. Pastikan Output Directory diisi `public`.
6. Tambahkan environment variables di tab **Environment Variables**.
7. Klik **Deploy**.

### Cara Update Project

**Update kode:**
1. Edit file di repository GitHub (atau push dari lokal).
2. Vercel akan trigger deploy otomatis.

**Update API key:**
1. Buka Vercel Dashboard → project Anda.
2. Masuk ke **Settings → Environment Variables**.
3. Edit atau tambah variable.
4. Klik **Redeploy** (tanpa cache) agar perubahan aktif.

## Endpoint API

| Method | Path | Deskripsi |
|---|---|---|
| `POST` | `/api/review` | Submit CV untuk dianalisis AI |
| `OPTIONS` | `/api/review` | CORS preflight |

Request body (`application/json`):

```json
{
  "extractedText": "...",
  "fileMetadata": { "name": "cv.pdf", "type": "PDF", "size": 123456, "extension": ".pdf" },
  "careerContext": {
    "targetRole": "Product Manager",
    "industry": "Teknologi",
    "experienceLevel": "Mid-level",
    "reviewMode": "senior_hr",
    "jobDescription": "..."
  }
}
```

## Catatan Penting

- Jangan commit file `.env` berisi API key asli ke GitHub.
- Jika muncul error `Origin request tidak diizinkan`, kosongkan `ALLOWED_ORIGINS` saat testing lokal.
- Gunakan model yang mendukung output teks/JSON panjang.
- PDF hasil scan gambar tidak didukung — aplikasi tidak menggunakan OCR.
- Vercel Hobby plan: batas timeout function 60 detik, sudah dikonfigurasi di `vercel.json`.
