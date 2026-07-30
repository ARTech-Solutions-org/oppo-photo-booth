/**
 * gemini.js
 * Backwards compatibility wrapper re-exporting processImage from ai-processor.js.
 */
const { processImage } = require('./ai-processor');

module.exports = { processImage };
