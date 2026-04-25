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

/**
 * POST /api/upload-audio
 * Accepts multipart/form-data with: audio (file), matchId (string).
 * Stores in pitch-audio bucket under client_id/match_id-timestamp.ext.
 * Saves storage path + metadata onto the podcast_match row.
 */
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/api/upload-audio', uploadAudio.single('audio'), async (req, res) => {
  try {
    const token = req.headers['x-dashboard-token'] || '';
    if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });
    if (!req.file) return res.status(400).json({ success: false, error: 'Missing audio file.' });

    const matchId = req.body.matchId;
    if (!matchId) return res.status(400).json({ success: false, error: 'Missing matchId.' });

    const { data: client } = await supabase.from('clients').select('id').eq('dashboard_token', token).single();
    if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

    const { data: match } = await supabase
      .from('podcast_matches')
      .select('id, audio_attachment_path')
      .eq('id', matchId)
      .eq('client_id', client.id)
      .single();
    if (!match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const mime = req.file.mimetype || 'audio/webm';
    const ext = (req.file.originalname || '').split('.').pop()?.toLowerCase() || (mime.includes('mp4') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : 'webm');
    const filename = `voice-intro.${ext}`;
    const storagePath = `${client.id}/${matchId}-${Date.now()}.${ext}`;

    if (match.audio_attachment_path) {
      await supabase.storage.from('pitch-audio').remove([match.audio_attachment_path]).catch(() => {});
    }

    const { error: uploadError } = await supabase.storage
      .from('pitch-audio')
      .upload(storagePath, req.file.buffer, { contentType: mime, upsert: false });

    if (uploadError) {
      logger.error('Audio storage upload failed', { matchId, error: uploadError.message });
      return res.status(500).json({ success: false, error: 'Storage upload failed.' });
    }

    await supabase.from('podcast_matches').update({
      audio_attachment_path:     storagePath,
      audio_attachment_filename: filename,
      audio_attachment_mime:     mime,
      audio_attachment_bytes:    req.file.size,
    }).eq('id', matchId);

    const { data: signed } = await supabase.storage
      .from('pitch-audio')
      .createSignedUrl(storagePath, 60 * 60);

    logger.info('Pitch audio uploaded', { matchId, bytes: req.file.size, mime });
    return res.json({ success: true, filename, mime, bytes: req.file.size, signedUrl: signed?.signedUrl || null });
  } catch (err) {
    logger.error('Audio upload error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Upload failed.' });
  }
});

/**
 * DELETE /api/upload-audio/:matchId
 * Removes the audio attachment from storage and clears the match metadata.
 */
router.delete('/api/upload-audio/:matchId', async (req, res) => {
  try {
    const token = req.headers['x-dashboard-token'] || '';
    if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });
    const { matchId } = req.params;

    const { data: client } = await supabase.from('clients').select('id').eq('dashboard_token', token).single();
    if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

    const { data: match } = await supabase
      .from('podcast_matches')
      .select('id, audio_attachment_path')
      .eq('id', matchId)
      .eq('client_id', client.id)
      .single();
    if (!match) return res.status(404).json({ success: false, error: 'Match not found.' });

    if (match.audio_attachment_path) {
      await supabase.storage.from('pitch-audio').remove([match.audio_attachment_path]).catch(() => {});
    }

    await supabase.from('podcast_matches').update({
      audio_attachment_path:     null,
      audio_attachment_filename: null,
      audio_attachment_mime:     null,
      audio_attachment_bytes:    null,
    }).eq('id', matchId);

    return res.json({ success: true });
  } catch (err) {
    logger.error('Audio delete error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Delete failed.' });
  }
});

/**
 * GET /api/audio-url/:matchId
 * Returns a short-lived signed URL so the client can preview the audio.
 */
router.get('/api/audio-url/:matchId', async (req, res) => {
  try {
    const token = req.headers['x-dashboard-token'] || '';
    if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });
    const { matchId } = req.params;

    const { data: client } = await supabase.from('clients').select('id').eq('dashboard_token', token).single();
    if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

    const { data: match } = await supabase
      .from('podcast_matches')
      .select('id, audio_attachment_path, audio_attachment_filename, audio_attachment_mime, audio_attachment_bytes')
      .eq('id', matchId)
      .eq('client_id', client.id)
      .single();
    if (!match || !match.audio_attachment_path) return res.json({ success: true, signedUrl: null });

    const { data: signed } = await supabase.storage
      .from('pitch-audio')
      .createSignedUrl(match.audio_attachment_path, 60 * 60);

    return res.json({
      success:   true,
      signedUrl: signed?.signedUrl || null,
      filename:  match.audio_attachment_filename,
      mime:      match.audio_attachment_mime,
      bytes:     match.audio_attachment_bytes,
    });
  } catch (err) {
    logger.error('Audio URL error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not get audio URL.' });
  }
});

module.exports = router;
