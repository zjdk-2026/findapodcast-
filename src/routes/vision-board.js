'use strict';
const express = require('express');
const supabase = require('../lib/supabase');
const { generateVisionBoard } = require('../services/visionBoard');
const requireDashboardToken = require('../middleware/requireDashboardToken');
const logger = require('../lib/logger');
const router = express.Router();

// POST /api/vision-board/generate — kick off generation, respond immediately
router.post('/vision-board/generate', requireDashboardToken, async (req, res) => {
  const clientId = req.clientId;

  // Check cooldown first (fast)
  const { data: client } = await supabase
    .from('clients')
    .select('vision_board_url, vision_board_generated_at')
    .eq('id', clientId)
    .single();

  if (client?.vision_board_url && client?.vision_board_generated_at) {
    const hoursSince = (Date.now() - new Date(client.vision_board_generated_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      return res.json({ success: true, cooldown: true, hoursLeft: Math.round((24 - hoursSince) * 10) / 10, imageUrl: client.vision_board_url });
    }
  }

  // Respond immediately — generation runs in background
  res.json({ success: true, generating: true });

  // Fire and forget
  generateVisionBoard(clientId).then((result) => {
    if (result?.imageUrl) {
      logger.info('Vision board generation complete', { clientId, imageUrl: result.imageUrl });
    }
  }).catch((err) => {
    logger.error('Vision board generation failed', { clientId, error: err.message });
  });
});

// GET /api/vision-board/status — poll for completion
router.get('/vision-board/status', requireDashboardToken, async (req, res) => {
  const { data: client } = await supabase
    .from('clients')
    .select('vision_board_url, vision_board_generated_at')
    .eq('id', req.clientId)
    .single();

  let hoursLeft = 0;
  if (client?.vision_board_generated_at) {
    const hoursSince = (Date.now() - new Date(client.vision_board_generated_at).getTime()) / (1000 * 60 * 60);
    hoursLeft = Math.max(0, 24 - hoursSince);
  }
  return res.json({ success: true, imageUrl: client?.vision_board_url || null, hoursLeft: Math.round(hoursLeft * 10) / 10 });
});

// GET /api/vision-board/debug — synchronous test, returns full error
router.get('/vision-board/debug', requireDashboardToken, async (req, res) => {
  try {
    const result = await generateVisionBoard(req.clientId);
    return res.json({ success: true, result });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

module.exports = router;
