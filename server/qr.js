/**
 * qr.js
 * Generates a QR code data URL for a given photo download link.
 */

const QRCode = require('qrcode');

/**
 * Generate a QR code as a base64 data URL.
 * @param {string} url - The URL to encode in the QR code.
 * @returns {Promise<string>} - Data URL (image/png base64)
 */
async function generateQRCode(url) {
  try {
    const dataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 400,
      color: {
        dark: '#0A0A0A',
        light: '#FFFFFF',
      },
    });
    return dataUrl;
  } catch (err) {
    console.error('[QR] Failed to generate QR code:', err);
    throw err;
  }
}

module.exports = { generateQRCode };
