'use strict';

const axios = require('axios');
const logger = require('./logger');

const BASE_URL = 'https://listen-api.listennotes.com/api/v2';
const API_KEY = process.env.LISTENNOTES_API_KEY;

/**
 * Shared axios instance with auth header.
 */
const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-ListenAPI-Key': API_KEY || '',
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

/**
 * searchPodcasts(query, params)
 * GET /search
 * @param {string} query - search query string
 * @param {object} params - additional query parameters
 * @returns {object|null}
 */
async function searchPodcasts(query, params = {}) {
  try {
    const response = await client.get('/search', {
      params: { q: query, ...params },
    });
    return response.data;
  } catch (err) {
    logger.error('Listen Notes searchPodcasts failed', {
      query,
      status: err.response?.status,
      message: err.message,
    });
    return null;
  }
}

/**
 * getBestPodcasts(params)
 * GET /best_podcasts
 * @param {object} params - query parameters (genre_id, page, region, etc.)
 * @returns {object|null}
 */
async function getBestPodcasts(params = {}) {
  try {
    const response = await client.get('/best_podcasts', { params });
    return response.data;
  } catch (err) {
    logger.error('Listen Notes getBestPodcasts failed', {
      params,
      status: err.response?.status,
      message: err.message,
    });
    return null;
  }
}

/**
 * getPodcast(id)
 * GET /podcasts/:id
 * @param {string} id - Listen Notes podcast ID
 * @returns {object|null}
 */
async function getPodcast(id) {
  try {
    const response = await client.get(`/podcasts/${id}`);
    return response.data;
  } catch (err) {
    logger.error('Listen Notes getPodcast failed', {
      id,
      status: err.response?.status,
      message: err.message,
    });
    return null;
  }
}

module.exports = { searchPodcasts, getBestPodcasts, getPodcast };
