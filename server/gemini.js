/**
 * gemini.js
 * Handles server-side Gemini API integration for OPPO-branded photo processing.
 * Uses @google/generative-ai v0.24 (GoogleGenerativeAI class).
 * The API key is read from .env and NEVER exposed to the client.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey || apiKey === 'your_gemini_api_key_here') {
  console.warn(
    '[Gemini] WARNING: No valid GEMINI_API_KEY in .env — image processing will use pass-through mode (original photo returned as-is).'
  );
}

const genAI =
  apiKey && apiKey !== 'your_gemini_api_key_here'
    ? new GoogleGenerativeAI(apiKey)
    : null;

/**
 * Process an image with Gemini to apply OPPO-branded visual treatment.
 * Falls back gracefully to the original image if Gemini is unavailable.
 *
 * @param {Buffer} imageBuffer - The raw image buffer from the upload
 * @param {string} mimeType - MIME type (e.g. 'image/jpeg')
 * @returns {Promise<Buffer>} - Processed image buffer
 */
async function processImage(imageBuffer, mimeType = 'image/jpeg') {
  if (!genAI) {
    console.log('[Gemini] No API key — returning original image unchanged.');
    return imageBuffer;
  }

  try {
    console.log('[Gemini] Sending image for OPPO-branded AI processing...');

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
    });

    const base64Image = imageBuffer.toString('base64');

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType,
          data: base64Image,
        },
      },
      {
        text: `You are an expert photo editor for OPPO smartphones. 
Apply a premium OPPO AI Camera visual treatment to this photo:
- Enhance colors with a slightly cool-toned, vivid color grade
- Boost contrast and clarity for a sharp, premium look
- Add a very subtle warm-to-cool gradient treatment in the highlights
- Enhance skin tones to look natural and flattering (if people are present)
- Make the image look like it was processed by OPPO's Hasselblad-tuned AI camera system
- Keep the composition and subjects exactly the same — only enhance, do not alter

Return ONLY the processed image, no text or explanation.`,
      },
    ]);

    const response = result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];

    for (const part of parts) {
      if (part.inlineData?.data) {
        console.log('[Gemini] ✓ Image processed successfully.');
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }

    // Gemini returned text only (model doesn't support image output with this key/quota)
    console.warn('[Gemini] No image data in response — returning original photo.');
    return imageBuffer;
  } catch (err) {
    console.error('[Gemini] API error:', err.message || err);
    // Always fall back to original so the event is never blocked
    return imageBuffer;
  }
}

module.exports = { processImage };
