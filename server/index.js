/**
 * server/index.js
 * Express + WebSocket server for OPPO Photobooth.
 * Vercel-ready: Uses in-memory sessions & Data URLs (No disk storage required).
 * Supports both WebSockets and HTTP Polling for universal cloud deployment.
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
const BASE_URL = process.env.BASE_URL || `https://${localIP}:${PORT}`;
const IDLE_TIMEOUT_SECONDS = parseInt(process.env.IDLE_TIMEOUT || '60', 10);

// ─── In-Memory Session Store (Vercel / Cloud compatible, zero disk requirement) ─
const sessionsMap = new Map();
let latestSession = null;

function setSession(session) {
  sessionsMap.set(session.id, session);
  if (session.status === 'ready') {
    latestSession = session;
  }

  // Keep memory clean: remove sessions older than 2 hours
  if (sessionsMap.size > 200) {
    const oldestKey = sessionsMap.keys().next().value;
    sessionsMap.delete(oldestKey);
  }
}

function getSession(id) {
  return sessionsMap.get(id) || null;
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '25mb' }));

// Serve static public files
app.use(express.static(path.join(__dirname, '../public')));

// Serve logo from assets
app.use('/assets/logo', express.static(path.join(__dirname, '../public/assets/logo')));

// ─── Multer (Memory Storage — No disk writes) ─────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
});

// ─── HTTPS / HTTP Server + WebSockets ─────────────────────────────────────────
let server;

// Use SSL certs if available locally, fallback to plain HTTP if missing (e.g. on Vercel)
const CERT_DIR = path.join(__dirname, 'certs');
const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const sslOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  server = https.createServer(sslOptions, app);
  console.log('[Server] Started with local HTTPS SSL certificates.');
} else {
  server = http.createServer(app);
  console.log('[Server] Started with HTTP server.');
}

// WebSockets (works on Render/Localhost, gracefully ignored if on Vercel)
let wss = null;
try {
  wss = new WebSocket.Server({ server });
  wss.on('connection', (ws, req) => {
    const clientType = new URL(req.url, `http://localhost`).searchParams.get('client') || 'unknown';
    console.log(`[WS] Client connected: ${clientType}`);

    if (clientType === 'display') {
      displayClients.add(ws);
    }

    ws.on('close', () => displayClients.delete(ws));
    ws.on('error', () => displayClients.delete(ws));
  });
} catch (e) {
  console.log('[WS] WebSockets initialized in passive mode.');
}

const displayClients = new Set();

function broadcastToDisplays(event, payload) {
  const message = JSON.stringify({ event, payload });
  for (const client of displayClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/config
 */
app.get('/api/config', (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const dynamicBaseUrl = `${protocol}://${host}`;

  res.json({
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
    baseUrl: dynamicBaseUrl,
  });
});

/**
 * GET /api/latest
 * Polling endpoint for Display screen (works on Vercel & Cloud without WebSockets).
 */
app.get('/api/latest', (_req, res) => {
  if (!latestSession) {
    return res.json({ id: null });
  }
  res.json({
    id: latestSession.id,
    imageUrl: latestSession.imageBase64,
    qrUrl: latestSession.qrUrl,
    timestamp: latestSession.timestamp,
  });
});

/**
 * POST /api/capture
 * Receives image, processes with AI, stores in-memory as Base64 Data URL.
 */
app.post('/api/capture', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file received.' });
  }

  const id = uuidv4();
  const mimeType = req.file.mimetype || 'image/jpeg';
  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const dynamicBaseUrl = `${protocol}://${host}`;

  console.log(`[Capture] New photo received — ID: ${id}`);

  // Save processing session
  setSession({
    id,
    timestamp: new Date().toISOString(),
    status: 'processing',
  });

  // Respond immediately to mobile client
  res.json({ id, status: 'processing' });

  // Async processing
  try {
    const imageBuffer = req.file.buffer;

    // Process image with active AI provider (Gemini / OpenAI)
    const processedBuffer = await processImage(imageBuffer, mimeType);

    // Convert processed image to Base64 Data URL (Zero disk write)
    const imageBase64 = `data:image/jpeg;base64,${processedBuffer.toString('base64')}`;

    // Generate QR code pointing to guest download page
    const photoPageUrl = `${dynamicBaseUrl}/photo/${id}`;
    const qrUrl = await generateQRCode(photoPageUrl);

    // Save final session to memory
    setSession({
      id,
      timestamp: new Date().toISOString(),
      status: 'ready',
      imageBase64,
      photoPageUrl,
      qrUrl,
    });

    console.log(`[Capture] 🎉 Photo ready! Broadcasting & updating latest session.`);

    // Broadcast via WebSockets if connected
    broadcastToDisplays('new_photo_ready', { id, imageUrl: imageBase64, qrUrl });
  } catch (err) {
    console.error('[Capture] Error during processing:', err.message || err);
    setSession({ id, status: 'error' });
    broadcastToDisplays('processing_error', { id, message: err.message });
  }
});

/**
 * GET /photo/:id
 * Guest download page — serves Base64 image directly so guest can download.
 */
app.get('/photo/:id', (req, res) => {
  const { id } = req.params;
  const session = getSession(id);

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

// Route capture and display pages
app.get('/capture', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/capture/index.html'));
});

app.get('/display', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/display/index.html'));
});

// Export app for Vercel Serverless Function export
module.exports = app;

// Start standalone server if run directly (node server/index.js)
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
