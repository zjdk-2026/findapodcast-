'use strict';

/**
 * pushNotifier.js
 * Sends Web Push notifications via the web-push npm package.
 *
 * Required env vars:
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 */

const webpush = require('web-push');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

function initWebPush() {
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || 'mailto:hi@findapodcast.io';
  if (pub && priv) {
    webpush.setVapidDetails(subj, pub, priv);
    return true;
  }
  return false;
}

/**
 * Notify a client that new matches are ready.
 */
async function notifyClientNewMatches(clientId, matchCount) {
  if (!initWebPush()) return; // VAPID not configured

  try {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('subscription, endpoint')
      .eq('client_id', clientId);

    if (!subs?.length) return;

    const payload = JSON.stringify({
      title: 'New Podcast Matches',
      body:  matchCount === 1
        ? '1 new podcast match is ready for your review.'
        : `${matchCount} new podcast matches are ready for your review.`,
      url:   '/dashboard',
    });

    await Promise.all(subs.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, payload);
      } catch (err) {
        // 410 Gone = subscription expired, clean it up
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
        }
      }
    }));

    logger.info('Push notifications sent', { clientId, matchCount, count: subs.length });
  } catch (err) {
    logger.error('notifyClientNewMatches error', { clientId, error: err.message });
  }
}

module.exports = { notifyClientNewMatches };
