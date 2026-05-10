# See My CV

Aplikasi web review CV berbasis AI dengan pendekatan **HR Professional Review**, arsitektur **static + serverless**, **multi-model AI fallback**, dan **zero persistence**.

## Halaman Aplikasi

| URL | Deskripsi |
|---|---|
| `/` | Landing page — penjelasan fitur, cara kerja, FAQ |
| `/review` | Halaman utama — form review CV untuk pengguna |
| `/about` | Tentang aplikasi, teknologi, dan kreator |

## Fitur Utama

- Upload CV format PDF dan DOCX (maks. 5MB)
- Parsing file sepenuhnya di browser (pdf.js + mammoth.js) — file tidak dikirim ke server
- Auto-detect bahasa CV (Indonesia / Inggris)
  - CV bahasa Inggris → seluruh review dalam Bahasa Indonesia, kecuali contoh perbaikan kalimat (rewriteExamples) yang tetap dalam bahasa Inggris
  - CV bahasa Indonesia → seluruh review dalam Bahasa Indonesia
- Review berbasis target posisi, industri, level pengalaman, dan job description
- Mode review: Balanced, HR Professional, Strict HR, Rejection Risk
- Skor keseluruhan (0–100) dan skor per 8 dimensi
- Kesan HR Professional dalam 10 detik pertama
- Kesalahan fatal dan risiko penolakan
- Prioritas perbaikan terurut berdasarkan dampak
- Contoh rewrite kalimat CV (before & after) dari teks CV asli
- Review per bagian CV
- Multi-model AI dengan fallback otomatis antar provider
- Serverless API proxy — API key tidak pernah terekspos ke browser
- Tanpa database, tanpa penyimpanan data CV (zero persistence)
- Formulir persetujuan pemrosesan data pribadi (consent gate)

## Struktur Project

```
/
├── api/
│   ├── review.js               ← Vercel Serverless Function (endpoint /api/review)
│   └── utils/
│       └── providers.js        ← Multi-model AI engine, language detection, prompt builder
├── public/
│   ├── index.html              ← Landing page (/)
│   ├── review.html             ← Halaman Review CV (/review)
│   ├── about.html              ← Halaman Tentang (/about)
│   ├── site.webmanifest        ← Web app manifest (PWA support)
│   ├── icons/
│   │   ├── icon-16.png         ← Favicon 16×16
│   │   ├── icon-32.png         ← Favicon 32×32
│   │   ├── icon-180.png        ← Apple Touch Icon 180×180
│   │   ├── icon-192.png        ← Android home screen 192×192
│   │   └── icon-512.png        ← PWA splash / high-res 512×512
│   ├── styles/
│   │   └── main.css            ← Design system & semua styling
│   └── scripts/
│       ├── api.js              ← Frontend API client & review normalizer
│       ├── fileParser.js       ← PDF & DOCX parser (browser-side)
│       ├── main.js             ← App entry point & review flow orchestrator
│       └── ui.js               ← UI factory & component renderer
├── vercel.json                 ← Konfigurasi routing, headers, dan function timeout
├── package.json
└── README.md
```

## AI Engine

Aplikasi menggunakan sistem multi-model dengan fallback otomatis. Jika satu model gagal atau kuota habis (HTTP 429), sistem secara otomatis berpindah ke model berikutnya tanpa interaksi dari pengguna.

### Urutan Fallback

| Prioritas | Provider | Model | Keterangan |
|---|---|---|---|
| 1 | Google Gemini | `gemini-3.1-pro-preview` | Main engine — reasoning terkuat |
| 2 | Google Gemini | `gemini-2.5-pro` | Second engine — stable, complex reasoning |
| 3 | Google Gemini | `gemini-3-flash-preview` | Third engine — medium reasoning |
| 4 | Google Gemini | `gemini-2.5-flash` | Fourth engine — stable, fast |
| 5 | Groq | `llama-3.3-70b-versatile` | Backup 1 — jika semua Gemini habis kuota |
| 6 | Mistral AI | `mistral-small-latest` | Backup 2 |
| 7 | Cohere | `command-r` | Backup 3 (opsional) |
| 8 | Hugging Face | `Qwen/Qwen2.5-72B-Instruct` | Backup 4 (opsional) |

### Distribusi API Key Gemini (2 Akun)

```
GEMINI_API_KEY_1 → Slot 1 (3.1 Pro) + Slot 3 (3 Flash)   — Akun Google 1
GEMINI_API_KEY_2 → Slot 2 (2.5 Pro) + Slot 4 (2.5 Flash) — Akun Google 2
```

Distribusi ini memisahkan kuota Pro dan Flash di tiap akun, sehingga satu akun tetap bisa melayani Flash request meskipun kuota Pro-nya habis.

## Deploy ke Vercel

### Build Settings (Vercel Dashboard)

| Setting | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | *(kosong)* |
| Build Command | *(kosong)* |
| Output Directory | `public` |
| Install Command | *(kosong)* |

> Tidak perlu build command — project ini static + serverless tanpa bundler.

### Environment Variables

#### Minimal (wajib)

```env
GEMINI_API_KEY_1="api_key_dari_akun_google_1"
GEMINI_API_KEY_2="api_key_dari_akun_google_2"
```

> Jika hanya memiliki satu akun Google, isi keduanya dengan key yang sama. Backward compatible: `GEMINI_API_KEY` (tanpa angka) juga masih diterima sebagai fallback.

#### Lengkap

```env
# Gemini — 2 akun untuk distribusi kuota (wajib minimal salah satu)
GEMINI_API_KEY_1=""
GEMINI_API_KEY_2=""

# Gemini model overrides (opsional — sudah ada default)
GEMINI_31_PRO_MODEL="gemini-3.1-pro-preview"
GEMINI_25_PRO_MODEL="gemini-2.5-pro"
GEMINI_3_FLASH_MODEL="gemini-3-flash-preview"
GEMINI_25_FLASH_MODEL="gemini-2.5-flash"

# Provider backup (opsional — aktif jika key diisi)
GROQ_API_KEY=""
MISTRAL_API_KEY=""
COHERE_API_KEY=""
HUGGINGFACE_API_KEY=""

# Model overrides provider backup (opsional)
GROQ_MODEL="llama-3.3-70b-versatile"
MISTRAL_MODEL="mistral-small-latest"
COHERE_MODEL="command-r"
HUGGINGFACE_MODEL="Qwen/Qwen2.5-72B-Instruct"

# CORS (kosongkan saat testing lokal, isi domain production)
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
1. Push perubahan ke GitHub.
2. Vercel akan trigger deploy otomatis.

**Update API key atau environment variable:**
1. Buka Vercel Dashboard → project → **Settings → Environment Variables**.
2. Edit atau tambah variable.
3. Klik **Redeploy → Redeploy without clearing cache** agar perubahan aktif.

**Update model Gemini (tanpa push kode):**
1. Ubah nilai `GEMINI_31_PRO_MODEL` atau model lainnya di Vercel env vars.
2. Redeploy.

## Endpoint API

| Method | Path | Deskripsi |
|---|---|---|
| `POST` | `/api/review` | Submit CV untuk dianalisis AI |
| `OPTIONS` | `/api/review` | CORS preflight |

Request body (`application/json`):

```json
{
  "extractedText": "...",
  "fileMetadata": {
    "name": "cv.pdf",
    "type": "PDF",
    "size": 123456,
    "extension": ".pdf"
  },
  "careerContext": {
    "targetRole": "Product Manager",
    "industry": "Teknologi",
    "experienceLevel": "Mid-level",
    "reviewMode": "senior_hr",
    "jobDescription": "..."
  }
}
```

Response sukses (`200`):

```json
{
  "review": { ... },
  "usedProvider": "Google Gemini 3.1 Pro",
  "usedModel": "gemini-3.1-pro-preview",
  "privacy": {
    "persisted": false,
    "message": "Data CV diproses sementara dan tidak disimpan oleh aplikasi ini."
  }
}
```

## Catatan Penting

- **Jangan commit API key** ke GitHub. Selalu gunakan Vercel Environment Variables.
- **CORS error saat testing lokal?** Kosongkan `ALLOWED_ORIGINS` di env vars.
- **PDF tidak terbaca?** Pastikan PDF berbasis teks, bukan hasil scan gambar. Aplikasi tidak menggunakan OCR.
- **Gemini preview models** (`gemini-3.1-pro-preview`, `gemini-3-flash-preview`) dapat deprecated sewaktu-waktu oleh Google dengan notifikasi minimal 2 minggu. Update `GEMINI_31_PRO_MODEL` / `GEMINI_3_FLASH_MODEL` di Vercel env vars jika ini terjadi — tanpa perlu push kode.
- **Vercel Hobby plan:** batas timeout function 60 detik, sudah dikonfigurasi di `vercel.json`.
- **README.md ini tidak dapat diakses** melalui URL publik aplikasi karena berada di root project, bukan di dalam folder `public/`. Visibilitasnya tergantung status GitHub repository (public/private).
