/**
 * server/index.js
 * Express + WebSocket server for OPPO Photobooth.
 * Vercel-ready: Uses in-memory sessions + Vercel KV REST API (100% FREE).
 * Supports Room Codes (?room=123) for connecting mobile and display.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { processImage } = require('./ai-processor');
const { generateQRCode } = require('./qr');
const { getLocalIP } = require('./ip-helper');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const localIP = getLocalIP();
const IDLE_TIMEOUT_SECONDS = parseInt(process.env.IDLE_TIMEOUT || '60', 10);

// ─── In-Memory Session Store ──────────────────────────────────────────────────
const sessionsMap = new Map();
let latestSession = null;

function setSession(session) {
  sessionsMap.set(session.id, session);
  if (session.status === 'ready') {
    latestSession = session;
  }
  if (sessionsMap.size > 200) {
    const oldestKey = sessionsMap.keys().next().value;
    sessionsMap.delete(oldestKey);
  }
}

function getSession(id) {
  return sessionsMap.get(id) || null;
}

// ─── Vercel KV / Upstash REST Helper (100% FREE, Zero extra packages) ────────
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL || process.env.VERCEL_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.VERCEL_KV_REST_API_TOKEN;
  if (!url || !token) return;

  try {
    await fetch(`${url}/set/${key}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
  } catch (e) {
    console.warn('[KV] Write warning:', e.message);
  }
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL || process.env.VERCEL_KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.VERCEL_KV_REST_API_TOKEN;
  if (!url || !token) return null;

  try {
    const res = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result) return null;
    return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
  } catch (e) {
    return null;
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '25mb' }));

// Serve static public files
app.use(express.static(path.join(__dirname, '../public')));
app.use('/assets/logo', express.static(path.join(__dirname, '../public/assets/logo')));

// Multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// HTTPS / HTTP Server
let server;
const CERT_DIR = path.join(__dirname, 'certs');
const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const sslOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(app);
}

// WebSockets (Localhost/Render)
const displayClients = new Set();
try {
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws, req) => {
    const clientType = new URL(req.url, `http://localhost`).searchParams.get('client') || 'unknown';
    if (clientType === 'display') displayClients.add(ws);
    ws.on('close', () => displayClients.delete(ws));
    ws.on('error', () => displayClients.delete(ws));
  });
} catch (e) {}

function broadcastToDisplays(event, payload) {
  const message = JSON.stringify({ event, payload });
  for (const client of displayClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  res.json({
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    baseUrl: `${protocol}://${host}`,
  });
});

/**
 * GET /api/latest
 * Polling endpoint for Display screen with room code support (?room=123).
 */
app.get('/api/latest', async (req, res) => {
  const room = (req.query.room || 'default').toLowerCase().trim();

  // Try Vercel KV first for multi-instance cloud sync
  const kvData = await kvGet(`latest_${room}`);
  if (kvData) {
    return res.json({
      id: kvData.id,
      imageUrl: kvData.imageBase64,
      qrUrl: kvData.qrUrl,
      timestamp: kvData.timestamp,
    });
  }

  // Fallback to local memory session
  if (!latestSession) return res.json({ id: null });

  res.json({
    id: latestSession.id,
    imageUrl: latestSession.imageBase64,
    qrUrl: latestSession.qrUrl,
    timestamp: latestSession.timestamp,
  });
});

/**
 * POST /api/capture
 * Receives image, processes with AI, syncs via KV & memory.
 */
app.post('/api/capture', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file received.' });

  const id = uuidv4();
  const room = (req.query.room || req.body.room || 'default').toLowerCase().trim();
  const mimeType = req.file.mimetype || 'image/jpeg';
  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const dynamicBaseUrl = `${protocol}://${host}`;

  console.log(`[Capture] New photo — ID: ${id} | Room: ${room}`);

  res.json({ id, status: 'processing' });

  try {
    const imageBuffer = req.file.buffer;
    const processedBuffer = await processImage(imageBuffer, mimeType);
    const imageBase64 = `data:image/jpeg;base64,${processedBuffer.toString('base64')}`;

    const photoPageUrl = `${dynamicBaseUrl}/photo/${id}`;
    const qrUrl = await generateQRCode(photoPageUrl);

    const sessionData = {
      id,
      timestamp: new Date().toISOString(),
      status: 'ready',
      imageBase64,
      photoPageUrl,
      qrUrl,
      room,
    };

    // Store locally and in Vercel KV for cloud sync
    setSession(sessionData);
    await kvSet(`latest_${room}`, sessionData);
    await kvSet(`session_${id}`, sessionData);

    console.log(`[Capture] 🎉 Photo ready! Synced to room "${room}".`);
    broadcastToDisplays('new_photo_ready', { id, imageUrl: imageBase64, qrUrl });
  } catch (err) {
    console.error('[Capture] Processing error:', err.message || err);
    broadcastToDisplays('processing_error', { id, message: err.message });
  }
});

/**
 * GET /photo/:id
 * Guest download page.
 */
app.get('/photo/:id', async (req, res) => {
  const { id } = req.params;
  let session = getSession(id);

  if (!session) {
    session = await kvGet(`session_${id}`);
  }

  if (!session || session.status !== 'ready') {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Photo Not Found — OPPO</title>
      <style>
        body { background: #0a0a0a; color: #fff; font-family: 'Poppins', sans-serif;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        h1 { color: #1AAE55; }
      </style>
      </head>
      <body><div style="text-align:center"><h1>OPPO Photobooth</h1><p>Photo expired or still processing. Try again!</p></div></body>
      </html>
    `);
  }

  const templatePath = path.join(__dirname, '../public/photo/index.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  html = html
    .replace(/\{\{IMAGE_URL\}\}/g, session.imageBase64)
    .replace(/\{\{PHOTO_ID\}\}/g, id)
    .replace(/\{\{TIMESTAMP\}\}/g, new Date(session.timestamp).toLocaleString());

  res.send(html);
});

// Root path redirect
app.get('/', (_req, res) => res.redirect('/display'));
app.get('/capture', (_req, res) => res.sendFile(path.join(__dirname, '../public/capture/index.html')));
app.get('/display', (_req, res) => res.sendFile(path.join(__dirname, '../public/display/index.html')));

module.exports = app;

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║    🟢  OPPO PHOTOBOOTH SERVER (VERCEL READY) STARTED 🟢  ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Display Screen :  https://localhost:${PORT}/display         ║`);
    console.log(`║  Mobile Capture :  https://${localIP}:${PORT}/capture   ║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
  });
}
