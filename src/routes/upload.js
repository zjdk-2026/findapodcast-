'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

/**
 * POST /api/upload-photo
 * Accepts multipart/form-data with fields: photo (file), token (string).
 * Uploads to Supabase Storage client-assets bucket, saves URL to clients table.
 */
router.post('/api/upload-photo', async (req, res) => {
  try {
    // Parse multipart manually using busboy-free approach via raw express body
    // We use the built-in Node.js multipart parsing via the request stream
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ success: false, error: 'Expected multipart/form-data.' });
    }

    // Use a simple chunk collector to parse the multipart body
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', resolve);
      req.on('error', reject);
    });

    const body = Buffer.concat(chunks);
    let boundary = contentType.split('boundary=')[1]?.trim();
    if (!boundary) return res.status(400).json({ success: false, error: 'No boundary in multipart.' });
    boundary = boundary.replace(/^"|"$/g, ''); // strip surrounding quotes if present

    // Parse multipart parts
    const parts = parseMultipart(body, boundary);
    const tokenPart = parts.find((p) => p.name === 'token');
    const photoPart = parts.find((p) => p.name === 'photo');

    logger.info('Upload parts found', { parts: parts.map(p => ({ name: p.name, size: p.data?.length })) });

    if (!photoPart) {
      logger.warn('Upload missing photo part', { parts: parts.map(p => p.name), bodyLen: body.length, boundary });
      return res.status(400).json({ success: false, error: 'Missing photo.' });
    }

    const token = (tokenPart ? tokenPart.data.toString('utf8').trim() : null)
      || req.headers['x-dashboard-token']
      || '';
    if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });

    // Look up client
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('dashboard_token', token)
      .single();

    if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

    // Determine file extension from filename or content-type
    const filename = photoPart.filename || 'photo.jpg';
    const ext = filename.split('.').pop().toLowerCase() || 'jpg';
    const mimeType = photoPart.contentType || 'image/jpeg';

    const storagePath = `photos/${client.id}.${ext}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('client-assets')
      .upload(storagePath, photoPart.data, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      logger.error('Supabase storage upload failed', { clientId: client.id, error: uploadError.message });
      return res.status(500).json({ success: false, error: 'Storage upload failed.' });
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('client-assets')
      .getPublicUrl(storagePath);

    const photo_url = urlData?.publicUrl;
    if (!photo_url) return res.status(500).json({ success: false, error: 'Could not get public URL.' });

    // Save URL to client record
    await supabase.from('clients').update({ photo_url }).eq('id', client.id);

    logger.info('Client photo uploaded', { clientId: client.id, photo_url });
    return res.json({ success: true, photo_url });
  } catch (err) {
    logger.error('Photo upload error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Upload failed.' });
  }
});

/**
 * Minimal multipart/form-data parser (no dependencies).
 * Returns array of { name, filename, contentType, data (Buffer) }.
 */
function parseMultipart(body, boundary) {
  const parts = [];
  const sep = Buffer.from('--' + boundary);
  const end = Buffer.from('--' + boundary + '--');

  let start = 0;
  while (start < body.length) {
    const sepIdx = indexOf(body, sep, start);
    if (sepIdx === -1) break;
    const headerStart = sepIdx + sep.length + 2; // skip \r\n
    if (headerStart >= body.length) break;

    // Check if this is the final boundary
    if (body.slice(sepIdx, sepIdx + end.length).equals(end)) break;

    const headerEnd = indexOf(body, Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headerStr = body.slice(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const nextSep = indexOf(body, sep, dataStart);
    const dataEnd = nextSep === -1 ? body.length : nextSep - 2; // trim \r\n before boundary

    const data = body.slice(dataStart, dataEnd);

    // Parse headers
    const dispositionMatch = headerStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
    const filenameMatch    = headerStr.match(/filename="([^"]+)"/i);
    const ctMatch          = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    if (dispositionMatch) {
      parts.push({
        name:        dispositionMatch[1],
        filename:    filenameMatch?.[1] || null,
        contentType: ctMatch?.[1]?.trim() || null,
        data,
      });
    }

    start = nextSep === -1 ? body.length : nextSep;
  }

  return parts;
}

function indexOf(buf, search, offset = 0) {
  for (let i = offset; i <= buf.length - search.length; i++) {
    let match = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

module.exports = router;
