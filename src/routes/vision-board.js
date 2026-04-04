'use strict';
const express = require('express');
const supabase = require('../lib/supabase');
const { generateVisionBoard } = require('../services/visionBoard');
const requireDashboardToken = require('../middleware/requireDashboardToken');
const router = express.Router();

// POST /api/vision-board/generate — manual regenerate (24hr cooldown enforced in service)
router.post('/vision-board/generate', requireDashboardToken, async (req, res) => {
  try {
    const result = await generateVisionBoard(req.clientId);
    if (result?.cooldown) {
      return res.status(429).json({ success: false, cooldown: true, hoursLeft: result.hoursLeft });
    }
    return res.json({ success: true, imageUrl: result?.imageUrl });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/vision-board/status — check cooldown
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
  return res.json({ success: true, imageUrl: client?.vision_board_url, hoursLeft: Math.round(hoursLeft * 10) / 10 });
});

module.exports = router;
