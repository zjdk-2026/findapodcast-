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

  return `A stunning professional magazine cover for "${client.name}", ${client.title || 'entrepreneur and thought leader'}.
Magazine masthead reads "FINDAPODCAST" in bold sans-serif at top.
Cover line: "THE ${bestAt.toUpperCase()} ISSUE".
Pull quote displayed prominently: ${purpose}.
${unlimitedVision ? `Background scene inspired by: ${unlimitedVision}.` : ''}
Style: ${vibe}.
Color palette dominated by ${primaryColor}.
Professional headshot placeholder in center. Ultra-realistic, editorial photography style, magazine quality, 8k resolution.
NOT a real person's face - use abstract silhouette or placeholder.`;
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
    const genRes = await axios.post('https://cloud.leonardo.ai/api/rest/v1/generations', {
      prompt,
      modelId: MODEL_ID,
      width: 832,
      height: 1152,
      num_images: 1,
      guidance_scale: 7,
      alchemy: true,
      presetStyle: 'CINEMATIC',
    }, {
      headers: {
        Authorization: `Bearer ${LEONARDO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    const generationId = genRes.data?.sdGenerationJob?.generationId;
    if (!generationId) throw new Error('No generation ID returned');

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
