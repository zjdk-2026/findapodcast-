'use strict';

const axios = require('axios');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');

const LEONARDO_API_KEY = process.env.LEONARDO_API_KEY;
// Phoenix model ID - Leonardo's best for photorealistic/magazine style
const MODEL_ID = 'de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3';

/**
 * Build a cinematic magazine cover prompt from client data
 */
function buildPrompt(client) {
  const vibeStyles = {
    'bold-professional': 'bold typography, dark dramatic lighting, high contrast, power, authority, executive magazine cover',
    'warm-human': 'warm golden tones, soft natural lighting, approachable, authentic, human connection',
    'clean-minimal': 'clean white space, minimalist design, elegant typography, modern, sophisticated',
    'creative-bold': 'vibrant colors, dynamic composition, creative energy, artistic, expressive',
  };
  const vibe = vibeStyles[client.visual_vibe] || vibeStyles['bold-professional'];
  const primaryColor = client.brand_color_primary || '#6C3EFF';
  const purpose = client.life_purpose ? `"${client.life_purpose.slice(0, 100)}"` : '';
  const bestAt = client.best_in_world_at ? client.best_in_world_at.slice(0, 80) : (client.topics?.[0] || 'Leadership');
  const unlimitedVision = client.unlimited_resources ? client.unlimited_resources.slice(0, 80) : '';
  const niche = client.topics?.[0] || 'Entrepreneurship';

  const prompt = `Magazine cover for "${client.name}", ${(client.title || 'entrepreneur').slice(0, 50)}. Masthead: FINDAPODCAST. Cover line: "${bestAt.slice(0, 60)} ISSUE". ${purpose ? `Quote: ${purpose}.` : ''} ${unlimitedVision ? `Scene: ${unlimitedVision}.` : ''} Style: ${vibe}. Color: ${primaryColor}. Abstract silhouette, no real face. Editorial photography, 8k.`;
  return prompt.slice(0, 1400);
}

/**
 * Generate vision board via Leonardo.ai API
 */
async function generateVisionBoard(clientId) {
  if (!LEONARDO_API_KEY) {
    logger.warn('LEONARDO_API_KEY not set, skipping vision board generation');
    return null;
  }

  // Check 24hr cooldown
  const { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (!client) throw new Error('Client not found');

  if (client.vision_board_url && client.vision_board_generated_at) {
    const lastGen = new Date(client.vision_board_generated_at).getTime();
    const hoursSince = (Date.now() - lastGen) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      const hoursLeft = (24 - hoursSince).toFixed(1);
      logger.info('Vision board generation cooldown active', { clientId, hoursLeft });
      return { cooldown: true, hoursLeft };
    }
  }

  const prompt = buildPrompt(client);
  logger.info('Generating vision board', { clientId, promptLength: prompt.length });

  try {
    // Step 1: Create generation
    const payload = {
      prompt,
      modelId: MODEL_ID,
      width: 832,
      height: 1152,
      num_images: 1,
    };
    logger.info('Leonardo API request', { clientId, payload });
    let genRes;
    try {
      genRes = await axios.post('https://cloud.leonardo.ai/api/rest/v1/generations', payload, {
        headers: {
          Authorization: `Bearer ${LEONARDO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
    } catch (apiErr) {
      const errDetail = apiErr.response?.data || apiErr.message;
      logger.error('Leonardo API call failed', { clientId, status: apiErr.response?.status, detail: JSON.stringify(errDetail) });
      throw new Error(`Leonardo API error ${apiErr.response?.status}: ${JSON.stringify(errDetail)}`);
    }
    logger.info('Leonardo API response', { clientId, data: JSON.stringify(genRes.data) });

    const generationId = genRes.data?.sdGenerationJob?.generationId;
    if (!generationId) throw new Error(`No generation ID returned. Response: ${JSON.stringify(genRes.data)}`);

    // Step 2: Poll for completion (up to 60 seconds)
    let imageUrl = null;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await axios.get(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, {
        headers: { Authorization: `Bearer ${LEONARDO_API_KEY}` },
        timeout: 10000,
      });
      const gen = pollRes.data?.generations_by_pk;
      if (gen?.status === 'COMPLETE') {
        imageUrl = gen.generated_images?.[0]?.url;
        break;
      }
      if (gen?.status === 'FAILED') throw new Error('Leonardo generation failed');
    }

    if (!imageUrl) throw new Error('Generation timed out');

    // Step 3: Save to Supabase
    await supabase.from('clients').update({
      vision_board_url: imageUrl,
      vision_board_generated_at: new Date().toISOString(),
    }).eq('id', clientId);

    logger.info('Vision board generated', { clientId, imageUrl });
    return { imageUrl };

  } catch (err) {
    logger.error('Vision board generation failed', { clientId, error: err.message });
    throw err;
  }
}

module.exports = { generateVisionBoard };
