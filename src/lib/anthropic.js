'use strict';

/**
 * OpenRouter LLM client — drop-in replacement for the Anthropic SDK.
 *
 * Provides the same `getClient().messages.create()` interface so all
 * downstream consumers (scoring, discovery, prefill, pitch, etc.) work
 * without changes.
 *
 * Environment variables:
 *   OPENROUTER_API_KEY   — required (or set one via RAILWAY_TOKEN on deploy)
 *   ANTHROPIC_API_KEY    — fallback if OPENROUTER_API_KEY is not set
 *   OPENROUTER_MODEL     — default model (default: google/gemini-2.0-flash-001)
 *
 * The library maps the Anthropic SDK format to OpenAI / OpenRouter format:
 *   Anthropic `system` → prepended system-role message
 *   model names starting with `claude-` → `anthropic/{name}`
 *   Response { content: [{ text: ... }] } ← standardised output
 */

const https = require('https');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';

let _client = null;

/**
 * Simple HTTPS POST returning parsed JSON.
 */
function postJSON(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const parsed = JSON.parse(raw);
          if (!res.statusCode || res.statusCode >= 400) {
            const err = new Error(parsed.error?.message || parsed.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.body = parsed;
            return reject(err);
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Invalid JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Map an Anthropic-style model name to the OpenRouter equivalent.
 * - `claude-haiku-4-5-20251001` → `anthropic/claude-3-5-haiku`
 * - `claude-*` → `anthropic/{name}`
 * - Everything else → passed through as-is
 */
function resolveModel(model) {
  if (!model) return DEFAULT_MODEL;
  const m = model.toLowerCase();
  if (m.startsWith('claude-')) {
    // Map snapshot versions to latest stable equivalents
    if (m.includes('haiku')) return 'anthropic/claude-3-5-haiku';
    if (m.includes('sonnet-4')) return 'anthropic/claude-sonnet-4';
    if (m.includes('sonnet')) return 'anthropic/claude-3-5-sonnet';
    if (m.includes('opus')) return 'anthropic/claude-opus-4';
    return `anthropic/${model}`;
  }
  return model;
}

/**
 * Build the provider routing header so OpenRouter prefers the primary provider.
 */
function getProviderHeader(model) {
  if (model.startsWith('anthropic/')) return JSON.stringify({ order: ['Anthropic'] });
  if (model.startsWith('openai/')) return JSON.stringify({ order: ['OpenAI'] });
  if (model.startsWith('google/')) return JSON.stringify({ order: ['Google'] });
  return undefined;
}

/**
 * Convert Anthropic system prompt + messages to OpenAI-format messages.
 * Anthropic puts `system` at the top level; OpenAI uses a system-role message.
 */
function buildMessages(system, messages) {
  const out = [];
  if (system) {
    out.push({ role: 'system', content: system });
  }
  for (const m of (messages || [])) {
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Public interface — matches the Anthropic SDK shape
// ────────────────────────────────────────────────────────────────────────────

function getClient() {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No API key found. Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY as fallback).'
      );
    }
    _client = {
      messages: {
        /**
         * Create a chat completion via OpenRouter.
         *
         * @param {Object} opts
         * @param {string}  opts.model       — OpenRouter model ID (e.g. "anthropic/claude-3-5-haiku")
         * @param {number}  opts.max_tokens  — max tokens in response
         * @param {string}  [opts.system]    — system prompt (Anthropic-style)
         * @param {Array}   opts.messages    — array of { role, content }
         * @returns {Promise<{ content: [{ text: string }] }>}
         */
        async create(opts = {}) {
          const model = resolveModel(opts.model);
          const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          };
          const providerHeader = getProviderHeader(model);
          if (providerHeader) {
            headers['X-Title'] = 'Find A Podcast';
            headers['HTTP-Referer'] = process.env.BASE_URL || 'https://findapodcast.io';
          }

          const payload = {
            model,
            max_tokens: opts.max_tokens || 1024,
            messages: buildMessages(opts.system, opts.messages),
            temperature: opts.temperature ?? 0.3,
          };

          const data = await postJSON(OPENROUTER_API, payload, headers);

          // Wrap in Anthropic-compatible shape
          const text = data?.choices?.[0]?.message?.content || '';
          return { content: [{ text }] };
        },
      },
    };
  }
  return _client;
}

module.exports = { getClient };
