/**
 * qr.js
 * Generates a lightweight QR code URL for a given photo download link.
 */

/**
 * Generate a QR code URL.
 * @param {string} url - The URL to encode in the QR code.
 * @returns {Promise<string>} - A direct URL to the QR code image
 */
async function generateQRCode(url) {
  // Using an external API to keep the payload size under 4KB for ntfy.sh
  return `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(url)}`;
}

module.exports = { generateQRCode };
