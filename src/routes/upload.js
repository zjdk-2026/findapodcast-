'use strict';

const express  = require('express');
const multer   = require('multer');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * POST /api/upload-photo
 * Accepts multipart/form-data with field: photo (file).
 * Uploads to Supabase Storage client-assets bucket, saves URL to clients table.
 */
router.post('/api/upload-photo', upload.single('photo'), async (req, res) => {
  try {
    const token = req.headers['x-dashboard-token'] || '';
    if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });

    if (!req.file) {
      logger.warn('Upload missing photo file');
      return res.status(400).json({ success: false, error: 'Missing photo.' });
    }

    // Look up client
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('dashboard_token', token)
      .single();

    if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

    const ext = (req.file.originalname || 'photo.jpg').split('.').pop().toLowerCase() || 'jpg';
    const mimeType = req.file.mimetype || 'image/jpeg';
    const storagePath = `photos/${client.id}.${ext}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('client-assets')
      .upload(storagePath, req.file.buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      logger.error('Supabase storage upload failed', { clientId: client.id, error: uploadError.message });
      return res.status(500).json({ success: false, error: 'Storage upload failed.' });
    }

    const { data: urlData } = supabase.storage
      .from('client-assets')
      .getPublicUrl(storagePath);

    const photo_url = urlData?.publicUrl;
    if (!photo_url) return res.status(500).json({ success: false, error: 'Could not get public URL.' });

    await supabase.from('clients').update({ photo_url }).eq('id', client.id);

    logger.info('Client photo uploaded', { clientId: client.id, photo_url });
    return res.json({ success: true, photo_url });
  } catch (err) {
    logger.error('Photo upload error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Upload failed.' });
  }
});

/**
 * POST /api/upload-photo-url
 * Fetches a photo from a URL (e.g. LinkedIn profile pic) and uploads to Supabase Storage.
 */
router.post('/api/upload-photo-url', async (req, res) => {
  try {
    const token = req.headers['x-dashboard-token'] || '';
    if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });

    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'Missing url.' });

    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('dashboard_token', token)
      .single();
    if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

    // Fetch photo from URL
    const imgRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!imgRes.ok) return res.status(400).json({ success: false, error: 'Could not fetch photo.' });

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const storagePath = `photos/${client.id}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('client-assets')
      .upload(storagePath, buffer, { contentType, upsert: true });

    if (uploadError) {
      logger.error('LinkedIn photo upload failed', { clientId: client.id, error: uploadError.message });
      return res.status(500).json({ success: false, error: 'Storage upload failed.' });
    }

    const { data: urlData } = supabase.storage.from('client-assets').getPublicUrl(storagePath);
    const photo_url = urlData?.publicUrl;
    if (!photo_url) return res.status(500).json({ success: false, error: 'Could not get public URL.' });

    await supabase.from('clients').update({ photo_url }).eq('id', client.id);

    logger.info('LinkedIn photo uploaded', { clientId: client.id });
    return res.json({ success: true, photo_url });
  } catch (err) {
    logger.error('Photo URL upload error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Upload failed.' });
  }
});

module.exports = router;
