/**
 * server/index.js
 * Express server for OPPO Photobooth.
 * Vercel-ready with zero-disk storage (Catbox.moe) + 100% Free Cloud State Sync (jsonblob.com).
 * Works instantly on Vercel & Localhost without requiring any API keys or databases!
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

// Removed jsonblob sync
const sessionsMap = new Map();
let latestSession = null;

function setSession(session) {
  sessionsMap.set(session.id, session);
  if (session.status === 'ready') latestSession = session;
  if (sessionsMap.size > 200) {
    const oldestKey = sessionsMap.keys().next().value;
    sessionsMap.delete(oldestKey);
  }
}

function getSession(id) {
  return sessionsMap.get(id) || null;
}

/**
 * Upload photo buffer to free direct cloud storage (tmpfiles.org)
 */
async function uploadToFreeHost(imageBuffer, filename = 'photo.jpg') {
  try {
    const form = new FormData();
    const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
    form.append('file', blob, filename);

    const res = await fetch('https://tmpfiles.org/api/v1/upload', {
      method: 'POST',
      body: form,
    });

    const data = await res.json();
    if (data && data.status === 'success' && data.data && data.data.url) {
      const directUrl = data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      console.log('[Cloud Storage] ✓ Uploaded to direct URL:', directUrl);
      return directUrl;
    }
  } catch (e) {
    console.warn('[Cloud Storage] Upload notice:', e.message);
  }
  return `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '25mb' }));

app.use(express.static(path.join(__dirname, '../public')));
app.use('/assets/logo', express.static(path.join(__dirname, '../public/assets/logo')));

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

// Local WebSockets
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

app.get('/api/latest', async (req, res) => {
  if (!latestSession) return res.json({ id: null });
  res.json({
    id: latestSession.id,
    imageUrl: latestSession.imageUrl,
    qrUrl: latestSession.qrUrl,
    timestamp: latestSession.timestamp,
  });
});

/**
 * POST /api/capture
 */
app.post('/api/capture', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file received.' });

  const room = req.query.room || 'default';

  const id = uuidv4();
  const mimeType = req.file.mimetype || 'image/jpeg';
  const host = req.get('host');
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const dynamicBaseUrl = `${protocol}://${host}`;

  console.log(`[Capture] New photo received — ID: ${id}`);

  try {
    const imageBuffer = req.file.buffer;

    // Process image (or pass-through if no API key)
    const processedBuffer = await processImage(imageBuffer, mimeType);

    // Direct cloud image URL
    const directImageUrl = await uploadToFreeHost(processedBuffer, `${id}.jpg`);

    const photoPageUrl = `${dynamicBaseUrl}/photo/${id}`;
    const qrUrl = await generateQRCode(photoPageUrl);

    const sessionData = {
      id,
      timestamp: new Date().toISOString(),
      status: 'ready',
      imageUrl: directImageUrl,
      photoPageUrl,
      qrUrl,
    };

    setSession(sessionData);

    // Using ntfy for instant display sync
    // Sync directly to ntfy.sh for instant display update on Vercel
    const ntfyUrl = `https://ntfy.sh/oppo_booth_${encodeURIComponent(room)}`;
    try {
      await fetch(ntfyUrl, {
        method: 'POST',
        body: JSON.stringify({ event: 'new_photo_ready', payload: { id, imageUrl: directImageUrl, qrUrl } })
      });
      console.log(`[ntfy] Published instant cloud event to room: ${room}`);
    } catch (e) {
      console.error('[ntfy] Error publishing:', e.message);
    }

    // Local WebSocket broadcast
    broadcastToDisplays('new_photo_ready', { id, imageUrl: directImageUrl, qrUrl });

    res.json({ id, status: 'ready', imageUrl: directImageUrl, qrUrl });
  } catch (err) {
    console.error('[Capture] Processing error:', err.message || err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/photo/:id', async (req, res) => {
  const { id } = req.params;
  let session = getSession(id);

  if (!session || (session.status && session.status !== 'ready')) {
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
    .replace(/\{\{IMAGE_URL\}\}/g, session.imageUrl)
    .replace(/\{\{PHOTO_ID\}\}/g, id)
    .replace(/\{\{TIMESTAMP\}\}/g, new Date(session.timestamp).toLocaleString());

  res.send(html);
});

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
