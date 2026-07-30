/**
 * ai-processor.js
 * Dynamic AI Photo Processor supporting Google Gemini and OpenAI (ChatGPT / DALL-E).
 * Generates an OPPO-themed AI portrait of the guest inside a futuristic OPPO branded environment.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const fs = require('fs');

/**
 * Mask API key for secure logging
 */
function maskKey(key) {
  if (!key) return '(none)';
  if (key.length <= 8) return '***';
  return key.substring(0, 5) + '...' + key.substring(key.length - 4);
}

/**
 * Main entry point for processing photos with AI.
 */
async function processImage(imageBuffer, mimeType = 'image/jpeg') {
  // Reload dotenv to pick up any runtime changes to .env
  require('dotenv').config({ path: require('path').join(__dirname, '../.env'), override: true });

  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase().trim();
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  console.log(`\n=================== [AI PROCESSOR] ===================`);
  console.log(`[AI] Active Provider Setting : "${provider}"`);
  console.log(`[AI] Gemini API Key Status  : ${geminiKey && geminiKey !== 'your_gemini_api_key_here' ? 'VALID (' + maskKey(geminiKey) + ')' : 'MISSING/DEFAULT'}`);
  console.log(`[AI] OpenAI API Key Status  : ${openaiKey && openaiKey !== 'your_openai_api_key_here' ? 'VALID (' + maskKey(openaiKey) + ')' : 'MISSING/DEFAULT'}`);
  console.log(`======================================================`);

  if (provider === 'openai') {
    return await processWithOpenAI(imageBuffer, mimeType, openaiKey);
  } else {
    return await processWithGemini(imageBuffer, mimeType, geminiKey);
  }
}

/**
 * Process photo using OpenAI (ChatGPT Vision + DALL-E 3 / DALL-E 2).
 */
async function processWithOpenAI(imageBuffer, mimeType, apiKey) {
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    console.warn('[OpenAI] ⚠️ Cannot process: OPENAI_API_KEY is missing or default in .env! Returning original photo.');
    return imageBuffer;
  }

  try {
    const openai = new OpenAI({ apiKey });
    const base64Image = imageBuffer.toString('base64');

    console.log('[OpenAI] Step 1/2: Analyzing photo features with ChatGPT Vision...');

    let subjectDescription = 'A stylish guest posing for OPPO photobooth';
    try {
      const visionRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe the person in this photo concisely (perceived gender, hair style/color, clothing style, pose) in under 25 words.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 80,
      });

      const desc = visionRes.choices?.[0]?.message?.content;
      if (desc) {
        subjectDescription = desc.trim();
        console.log(`[OpenAI] ✓ Vision Analysis: "${subjectDescription}"`);
      }
    } catch (vErr) {
      console.warn('[OpenAI] Note: Vision step skipped:', vErr.message || vErr);
    }

    // Step 2: Generate futuristic OPPO environment portrait
    console.log('[OpenAI] Step 2/2: Generating OPPO-themed AI portrait...');
    const dallEPrompt = `A professional photorealistic portrait of ${subjectDescription}, standing inside a futuristic OPPO AI event booth. The background features glowing neon OPPO green lights, sleek futuristic OPPO smartphone displays, Hasselblad camera branding accents, luxury emerald illumination, cinematic depth of field, 8k resolution studio photo.`;

    console.log(`[OpenAI] Generation Prompt:\n  "${dallEPrompt}"`);

    // Try dall-e-3 first, fallback to dall-e-2
    let imageRes = null;
    let usedModel = 'dall-e-3';

    try {
      imageRes = await openai.images.generate({
        model: 'dall-e-3',
        prompt: dallEPrompt,
        n: 1,
        size: '1024x1024',
      });
    } catch (d3Err) {
      console.warn('[OpenAI] dall-e-3 model unavailable for this key, trying dall-e-2 fallback...');
      usedModel = 'dall-e-2';
      imageRes = await openai.images.generate({
        model: 'dall-e-2',
        prompt: dallEPrompt.substring(0, 950), // dall-e-2 prompt max 1000 chars
        n: 1,
        size: '1024x1024',
      });
    }

    const imageUrl = imageRes.data?.[0]?.url;
    if (imageUrl) {
      console.log(`[OpenAI] Downloading generated image from ${usedModel}...`);
      const fetchRes = await fetch(imageUrl);
      const arrayBuffer = await fetchRes.arrayBuffer();
      console.log(`[OpenAI] 🎉 SUCCESS! OPPO AI environment photo generated with ${usedModel}.`);
      return Buffer.from(arrayBuffer);
    }

    console.warn('[OpenAI] ⚠️ No image URL returned — returning original photo.');
    return imageBuffer;
  } catch (err) {
    console.error('[OpenAI] ❌ API ERROR DETAILS:');
    console.error(`  - Message: ${err.message}`);
    console.error(`  - Code   : ${err.code || 'N/A'}`);
    console.error(`  - Status : ${err.status || 'N/A'}`);

    if (err.message && err.message.includes('quota')) {
      console.error('\n  👉 NOTE: Your OpenAI API key has exceeded its billing quota (Error 429). Please add credits to your OpenAI account at https://platform.openai.com/account/billing');
    }

    console.warn('[OpenAI] Returning original photo due to API error.');
    return imageBuffer;
  }
}

/**
 * Process photo using Google Gemini AI.
 */
async function processWithGemini(imageBuffer, mimeType, apiKey) {
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    console.warn('[Gemini] ⚠️ Cannot process: GEMINI_API_KEY is missing or default in .env! Returning original photo.');
    return imageBuffer;
  }

  try {
    console.log('[Gemini] Sending image for OPPO AI environment enhancement...');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const base64Image = imageBuffer.toString('base64');

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType,
          data: base64Image,
        },
      },
      {
        text: `You are an expert photo generator for OPPO smartphones event photobooth. 
Transform this photo into an ultra-realistic OPPO AI Camera portrait:
- Place the person in a futuristic OPPO event environment with glowing neon green OPPO accents, Hasselblad camera logos, and modern tech backdrop
- Enhance skin tones, lighting, and colors to look like a high-fashion OPPO AI portrait
- Keep the person's identity and face structure intact
Return ONLY the processed image, no text or markdown.`,
      },
    ]);

    const parts = result.response?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        console.log('[Gemini] 🎉 SUCCESS! Photo enhanced with Gemini AI OPPO environment.');
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }

    console.warn('[Gemini] ⚠️ Model returned text instead of image data — returning original photo.');
    return imageBuffer;
  } catch (err) {
    console.error('[Gemini] ❌ API ERROR DETAILS:');
    console.error(`  - Message: ${err.message}`);
    console.error(`  - Code   : ${err.code || 'N/A'}`);
    console.warn('[Gemini] Returning original photo due to error.');
    return imageBuffer;
  }
}

module.exports = { processImage };
