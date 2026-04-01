'use strict';

/**
 * Structured JSON logger.
 * Each line is a JSON object with: timestamp, level, message, and any extra fields.
 *
 * Usage:
 *   logger.info('Discovery complete', { clientId, count: 42 });
 *   logger.error('Something failed', { error: err.message, stack: err.stack });
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const currentLevelValue = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(level, message, extra = {}) {
  if ((LEVELS[level] ?? 0) < currentLevelValue) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...extra,
  };

  const line = JSON.stringify(entry);

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const logger = {
  debug: (message, extra) => log('debug', message, extra),
  info:  (message, extra) => log('info',  message, extra),
  warn:  (message, extra) => log('warn',  message, extra),
  error: (message, extra) => log('error', message, extra),
};

module.exports = logger;
