/**
 * server/index.js
 * Main Express + WebSocket server for the OPPO Photobooth app.
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

const { processImage } = require('./gemini');
const { generateQRCode } = require('./qr');
const { getLocalIP } = require('./ip-helper');

// ─── Config ───────────────────────────────────────────────────────────────────
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8')
);
const PORT = config.port || 3000;
const localIP = getLocalIP();
const BASE_URL = config.baseUrl || `https://${localIP}:${PORT}`;
const SESSION_FILE = path.join(__dirname, '../', config.sessionFile || 'server/sessions.json');
const UPLOAD_DIR = path.join(__dirname, '../', config.uploadDir || 'uploads');
const ORIGINAL_DIR = path.join(UPLOAD_DIR, 'original');
const PROCESSED_DIR = path.join(UPLOAD_DIR, 'processed');

// ─── Ensure directories exist ─────────────────────────────────────────────────
[ORIGINAL_DIR, PROCESSED_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Session store helpers ────────────────────────────────────────────────────
function readSessions() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2), 'utf8');
}

function upsertSession(entry) {
  const sessions = readSessions();
  const idx = sessions.findIndex((s) => s.id === entry.id);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...entry };
  } else {
    sessions.push(entry);
  }
  writeSessions(sessions);
}

function getSession(id) {
  return readSessions().find((s) => s.id === id) || null;
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve static public files
app.use(express.static(path.join(__dirname, '../public')));

// Serve uploaded processed images
app.use('/uploads', express.static(UPLOAD_DIR));

// Serve logo from project root (LOGO.png → /assets/logo/oppo-logo.png)
app.use('/assets/logo', express.static(path.join(__dirname, '../public/assets/logo')));

// ─── Multer (file upload) ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: ORIGINAL_DIR,
  filename: (_req, _file, cb) => {
    cb(null, `${uuidv4()}-original.jpg`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ─── HTTPS Server + WebSocket ─────────────────────────────────────────────────
const CERT_DIR = path.join(__dirname, 'certs');
const sslOptions = {
  key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
};
const server = https.createServer(sslOptions, app);
const wss = new WebSocket.Server({ server });

// Track all connected display clients
const displayClients = new Set();

wss.on('connection', (ws, req) => {
  const clientType = new URL(req.url, `http://localhost`).searchParams.get('client') || 'unknown';
  console.log(`[WS] Client connected: ${clientType}`);

  if (clientType === 'display') {
    displayClients.add(ws);
  }

  ws.on('close', () => {
    displayClients.delete(ws);
    console.log(`[WS] Client disconnected: ${clientType}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    displayClients.delete(ws);
  });
});

/**
 * Broadcast a message to all connected display screen clients.
 */
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
 * Returns safe config values for the client (idle timeout, etc.).
 */
app.get('/api/config', (_req, res) => {
  res.json({
    idleTimeoutSeconds: config.idleTimeoutSeconds,
    baseUrl: BASE_URL,
  });
});

/**
 * GET /api/status
 * Returns server status and last session info.
 */
app.get('/api/status', (_req, res) => {
  const sessions = readSessions();
  const last = sessions.length > 0 ? sessions[sessions.length - 1] : null;
  res.json({
    status: 'ok',
    connectedDisplays: displayClients.size,
    totalSessions: sessions.length,
    lastSession: last,
    config: {
      idleTimeoutSeconds: config.idleTimeoutSeconds,
    },
  });
});

/**
 * POST /api/capture
 * Receives image from mobile, processes with Gemini, generates QR, broadcasts to display.
 */
app.post('/api/capture', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file received.' });
  }

  const id = uuidv4();
  const originalPath = req.file.path;
  const processedFilename = `${id}-processed.jpg`;
  const processedPath = path.join(PROCESSED_DIR, processedFilename);

  console.log(`[Capture] New photo — ID: ${id}`);

  // Save initial session entry
  upsertSession({
    id,
    timestamp: new Date().toISOString(),
    status: 'processing',
    originalPath: path.relative(process.cwd(), originalPath),
    processedPath: null,
  });

  // Respond immediately so mobile can show "Processing..." without waiting
  res.json({ id, status: 'processing' });

  // ── Async processing (non-blocking after response) ──
  try {
    // Read original image
    const imageBuffer = fs.readFileSync(originalPath);
    const mimeType = req.file.mimetype || 'image/jpeg';

    // Process with Gemini
    const processedBuffer = await processImage(imageBuffer, mimeType);

    // Save processed image
    fs.writeFileSync(processedPath, processedBuffer);

    // Generate QR code pointing to the guest download page
    const photoPageUrl = `${BASE_URL}/photo/${id}`;
    const qrDataUrl = await generateQRCode(photoPageUrl);

    // Build public URLs
    const imageUrl = `/uploads/processed/${processedFilename}`;
    const qrUrl = qrDataUrl; // base64 data URL — no separate endpoint needed

    // Update session
    upsertSession({
      id,
      status: 'ready',
      processedPath: path.relative(process.cwd(), processedPath),
      photoPageUrl,
    });

    console.log(`[Capture] ✓ Photo ready — broadcasting to ${displayClients.size} display(s)`);

    // Broadcast to display screen(s)
    broadcastToDisplays('new_photo_ready', { id, imageUrl, qrUrl });
  } catch (err) {
    console.error('[Capture] Processing error:', err);
    upsertSession({ id, status: 'error' });
    broadcastToDisplays('processing_error', { id, message: err.message });
  }
});

/**
 * GET /photo/:id
 * Guest download page — served as a dynamic HTML page.
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
      <body><div style="text-align:center"><h1>OPPO Photobooth</h1><p>Photo not found or still processing. Try again in a moment!</p></div></body>
      </html>
    `);
  }

  const processedFilename = path.basename(session.processedPath || '');
  const imageUrl = `/uploads/processed/${processedFilename}`;

  // Serve the static download page template with injected values
  const templatePath = path.join(__dirname, '../public/photo/index.html');
  let html = fs.readFileSync(templatePath, 'utf8');
  html = html
    .replace(/\{\{IMAGE_URL\}\}/g, imageUrl)
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

// ─── Start server ─────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        🟢  OPPO PHOTOBOOTH SERVER (HTTPS) STARTED  🟢    ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Display Screen :  https://localhost:${PORT}/display         ║`);
  console.log(`║  Mobile Capture :  https://${localIP}:${PORT}/capture   ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
