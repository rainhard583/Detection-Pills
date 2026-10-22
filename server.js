'use strict';

const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Konfigurasi Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// Konfigurasi Roboflow
const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_MODEL_ID = process.env.ROBOFLOW_MODEL_ID;

// Konfigurasi SATUSEHAT KFA Sandbox
const SATUSEHAT_BASE_URL = (process.env.SATUSEHAT_BASE_URL || 'https://api-satusehat-stg.dto.kemkes.go.id').replace(/\/$/, '');
const SATUSEHAT_CLIENT_ID = process.env.SATUSEHAT_CLIENT_ID;
const SATUSEHAT_CLIENT_SECRET = process.env.SATUSEHAT_CLIENT_SECRET;
let satusehatTokenCache = { token: null, expiresAt: 0 };

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function parseImageDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== 'string') return null;

  const match = imageDataUrl.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/
  );

  if (!match) return null;

  const buffer = Buffer.from(match[2], 'base64');

  if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
    return null;
  }

  return {
    mimeType: match[1],
    base64Data: match[2],
    buffer,
  };
}

function sanitizePredictions(predictions) {
  return Array.isArray(predictions)
    ? predictions.slice(0, 100).map((p) => ({
        class: String(p?.class || 'unknown').slice(0, 80),
        confidence: Number.isFinite(Number(p?.confidence))
          ? Number(p.confidence)
          : null,
      }))
    : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestGeminiModel(model, parts) {
  const apiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1400,
        },
      }),
    }
  );

  const payload = await apiResponse.json().catch(() => ({}));

  if (!apiResponse.ok) {
    const error = new Error(
      payload?.error?.message ||
      `Permintaan Gemini gagal (HTTP ${apiResponse.status}).`
    );

    error.status = apiResponse.status;
    error.retryable = [429, 500, 502, 503, 504].includes(
      apiResponse.status
    );

    throw error;
  }

  const text = (payload.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('\n')
    .trim();

  if (!text) {
    const error = new Error(
      'Gemini tidak mengembalikan teks. Coba lagi.'
    );

    error.status = 502;
    error.retryable = true;

    throw error;
  }

  return text;
}

async function callGemini({ prompt, image }) {
  if (!GEMINI_API_KEY) {
    const error = new Error(
      'GEMINI_API_KEY belum diatur di file .env.'
    );

    error.status = 503;
    throw error;
  }

  const parts = [{ text: prompt }];

  if (image) {
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.base64Data,
      },
    });
  }

  // Retry terbatas untuk error sementara.
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await requestGeminiModel(GEMINI_MODEL, parts);

      return {
        text,
        model: GEMINI_MODEL,
      };
    } catch (error) {
      lastError = error;

      console.error(
        `Gemini model ${GEMINI_MODEL}, percobaan ${attempt}/${maxAttempts}:`,
        error.message
      );

      if (!error.retryable || attempt === maxAttempts) {
        break;
      }

      await sleep(1500 * attempt);
    }
  }

  // Model cadangan opsional, harus tersedia untuk API key.
  const fallbackModel = String(
    process.env.GEMINI_FALLBACK_MODEL || ''
  ).trim();

  if (fallbackModel && fallbackModel !== GEMINI_MODEL) {
    try {
      const text = await requestGeminiModel(fallbackModel, parts);

      console.warn(
        `Gemini memakai model fallback: ${fallbackModel}`
      );

      return {
        text,
        model: fallbackModel,
      };
    } catch (fallbackError) {
      console.error(
        `Gemini fallback ${fallbackModel} gagal:`,
        fallbackError.message
      );

      lastError = fallbackError;
    }
  }

  const error = new Error(
    lastError?.message ||
    'Gemini sedang tidak tersedia. Periksa model, kuota, dan konfigurasi API key.'
  );

  error.status =
    lastError?.status === 429
      ? 429
      : (lastError?.status || 502);

  throw error;
}

// Mengambil token SATUSEHAT dan menyimpannya di cache.
async function getSatusehatAccessToken() {
  if (
    satusehatTokenCache.token &&
    Date.now() < satusehatTokenCache.expiresAt - 60000
  ) {
    return satusehatTokenCache.token;
  }

  if (!SATUSEHAT_CLIENT_ID || !SATUSEHAT_CLIENT_SECRET) {
    const error = new Error(
      'SATUSEHAT_CLIENT_ID dan SATUSEHAT_CLIENT_SECRET belum diisi di file .env.'
    );

    error.status = 503;
    throw error;
  }

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SATUSEHAT_CLIENT_ID,
    client_secret: SATUSEHAT_CLIENT_SECRET,
  });

  const response = await fetch(
    `${SATUSEHAT_BASE_URL}/oauth2/v1/accesstoken?grant_type=client_credentials`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    console.error(
      'SATUSEHAT token error:',
      response.status,
      payload?.fault?.faultstring ||
      payload?.error_description ||
      payload?.error ||
      'unknown'
    );

    const error = new Error(
      `Gagal mendapatkan token SATUSEHAT (HTTP ${response.status}). Periksa kredensial Sandbox di .env.`
    );

    error.status =
      response.status === 400 || response.status === 401
        ? 502
        : response.status;

    throw error;
  }

  const lifetimeSeconds = Number(payload.expires_in) || 3600;

  satusehatTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + lifetimeSeconds * 1000,
  };

  return satusehatTokenCache.token;
}

// Status server.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    roboflowConfigured: Boolean(
      ROBOFLOW_API_KEY && ROBOFLOW_MODEL_ID
    ),
    satusehatConfigured: Boolean(
      SATUSEHAT_CLIENT_ID && SATUSEHAT_CLIENT_SECRET
    ),
  });
});

// SATUSEHAT KFA.
app.get('/api/kfa/search', async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '')
      .trim()
      .slice(0, 120);

    const page = Math.max(
      1,
      Math.min(1000, Number.parseInt(req.query.page, 10) || 1)
    );

    const size = Math.max(
      1,
      Math.min(50, Number.parseInt(req.query.size, 10) || 10)
    );

    if (!keyword) {
      return res.status(400).json({
        error: 'Parameter keyword wajib diisi. Contoh: /api/kfa/search?keyword=Paramex',
      });
    }

    const token = await getSatusehatAccessToken();

    const url = new URL(
      `${SATUSEHAT_BASE_URL}/kfa-v2/products/all`
    );

    url.search = new URLSearchParams({
      page: String(page),
      size: String(size),
      product_type: 'farmasi',
      keyword,
    }).toString();

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        'SATUSEHAT KFA error:',
        response.status,
        JSON.stringify(payload).slice(0, 1000)
      );

      return res.status(response.status).json({
        error: `Pencarian KFA gagal (HTTP ${response.status}). Periksa akses KFA Sandbox dan parameter request.`,
        details: payload,
      });
    }

    return res.json({
      keyword,
      page,
      size,
      source: 'SATUSEHAT KFA Sandbox',
      data: payload,
    });
  } catch (error) {
    console.error(
      'SATUSEHAT KFA search failed:',
      error.message
    );

    return res.status(error.status || 502).json({
      error: error.message ||
        'Gagal menghubungi SATUSEHAT KFA.',
    });
  }
});

// Roboflow.
app.post('/api/roboflow/detect', async (req, res) => {
  try {
    if (!ROBOFLOW_API_KEY || !ROBOFLOW_MODEL_ID) {
      return res.status(503).json({
        error: 'ROBOFLOW_API_KEY dan ROBOFLOW_MODEL_ID harus diatur di file .env.',
      });
    }

    const image = parseImageDataUrl(req.body?.imageDataUrl);

    if (!image) {
      return res.status(400).json({
        error: 'Gambar tidak valid. Gunakan PNG, JPG/JPEG, atau WEBP maksimal 10 MB.',
      });
    }

    const confidence = Math.min(
      100,
      Math.max(1, Number(req.body?.confidence) || 85)
    );

    const modelPath = ROBOFLOW_MODEL_ID
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const apiResponse = await fetch(
      `https://detect.roboflow.com/${modelPath}?api_key=${encodeURIComponent(ROBOFLOW_API_KEY)}&confidence=${confidence}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: image.base64Data,
      }
    );

    const payload = await apiResponse.json().catch(() => ({}));

    if (!apiResponse.ok) {
      console.error(
        'Roboflow API error:',
        apiResponse.status,
        JSON.stringify(payload).slice(0, 1200)
      );

      const upstreamMessage =
        payload?.message ||
        payload?.error ||
        payload?.detail ||
        JSON.stringify(payload) ||
        'Roboflow tidak mengembalikan detail error.';

      const safeStatus = [
        400, 401, 403, 404, 413, 422, 429,
      ].includes(apiResponse.status)
        ? apiResponse.status
        : 502;

      return res.status(safeStatus).json({
        error: `Roboflow menolak permintaan (HTTP ${apiResponse.status}): ${String(upstreamMessage).slice(0, 700)}. Periksa API key, Model ID project/version, dan deployment Roboflow.`,
        upstreamStatus: apiResponse.status,
      });
    }

    return res.json(payload);
  } catch (error) {
    console.error(
      'Roboflow request failed:',
      error.message
    );

    return res.status(502).json({
      error: `Server gagal menghubungi Roboflow: ${error.message}`,
    });
  }
});

// Gemini menganalisis gambar bersama hasil prediksi YOLO/Roboflow.
app.post('/api/gemini/analyze', async (req, res) => {
  try {
    const image = parseImageDataUrl(req.body?.imageDataUrl);

    if (!image) {
      return res.status(400).json({
        error: 'Gambar tidak valid. Format harus PNG, JPEG, atau WEBP maksimal 10 MB.',
      });
    }

    const safePredictions = sanitizePredictions(
      req.body?.predictions
    );

    const prompt = `Anda adalah asisten informasi obat untuk aplikasi PillScan AI. Jawab dalam bahasa Indonesia yang jelas dan terstruktur. Hasil deteksi visual YOLO tersedia: ${JSON.stringify(safePredictions)}.

Tugas:
1. Identifikasi kemungkinan nama/merek dan jenis obat hanya jika ada bukti visual cukup. Bentuk/warna pil saja biasanya tidak cukup; jika tidak jelas, nyatakan belum dapat dipastikan dan minta foto kemasan/blister/etiket yang terbaca.
2. Jelaskan ciri visual dan kondisi fisik yang tampak. Perlakukan label YOLO sebagai prediksi, bukan kebenaran pasti.
3. Jangan meresepkan dosis personal atau menyarankan penggunaan hanya dari foto pil. Jika nama, zat aktif, kekuatan (mg), dan label/leaflet tidak terbaca/terverifikasi, nyatakan dosis tidak dapat ditentukan dan jangan mengarang angka. Jika informasi kemasan terbaca, rangkum hanya yang terlihat dan sarankan mengikuti leaflet resmi/apoteker.
4. Jika obat tampak rusak, sarankan jangan digunakan sebelum dikonfirmasi apoteker/produsen.
5. Jelaskan bahwa AI bisa salah dan tidak menggantikan dokter/apoteker.

Gunakan judul: Kemungkinan identitas, Kondisi fisik, Informasi dosis, Langkah aman.`;

    const result = await callGemini({ prompt, image });

    return res.json({
      analysis: result.text,
      model: result.model,
    });
  } catch (error) {
    console.error(
      'Gemini analysis failed:',
      error.message
    );

    return res.status(error.status || 500).json({
      error: error.message ||
        'Kesalahan server saat menganalisis gambar.',
    });
  }
});

// Tanya Gemini AI.
app.post('/api/gemini/chat', async (req, res) => {
  try {
    const question = String(req.body?.question || '')
      .trim()
      .slice(0, 2000);

    if (!question) {
      return res.status(400).json({
        error: 'Tulis pertanyaan terlebih dahulu.',
      });
    }

    const image = req.body?.imageDataUrl
      ? parseImageDataUrl(req.body.imageDataUrl)
      : null;

    if (req.body?.imageDataUrl && !image) {
      return res.status(400).json({
        error: 'Gambar yang dikirim tidak valid.',
      });
    }

    const predictions = sanitizePredictions(
      req.body?.predictions
    );

    const prompt = `Anda adalah asisten informasi obat PillScan AI. Jawab dalam bahasa Indonesia, jelas, tidak mengarang fakta, dan jelaskan keterbatasan bila informasi tidak cukup.

Data deteksi YOLO (prediksi, bukan kepastian): ${JSON.stringify(predictions)}.
Pertanyaan pengguna: ${question}

Aturan keselamatan: jangan memastikan identitas pil hanya dari bentuk/warna; jangan mengarang dosis atau membuat resep personal. Untuk identitas dan dosis, minta pengguna memeriksa kemasan/leaflet yang terbaca atau bertanya kepada apoteker. Jika obat terlihat retak, patah, berubah warna, atau rusak, sarankan tidak digunakan sebelum dikonfirmasi apoteker/produsen. Untuk kondisi darurat, arahkan mencari bantuan medis. AI bukan pengganti dokter/apoteker.`;

    const result = await callGemini({ prompt, image });

    return res.json({
      answer: result.text,
      model: result.model,
    });
  } catch (error) {
    console.error(
      'Gemini chat failed:',
      error.message
    );

    return res.status(error.status || 500).json({
      error: error.message ||
        'Kesalahan server saat menjawab pertanyaan.',
    });
  }
});

// Handler 404 untuk API yang tidak ditemukan.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: `Endpoint API tidak ditemukan: ${req.method} ${req.originalUrl}`,
  });
});

// Vercel dan server lokal.
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`PillScan AI berjalan di http://localhost:${PORT}`);
    console.log(
      `Endpoint KFA: http://localhost:${PORT}/api/kfa/search?keyword=Paramex`
    );
  });
}
