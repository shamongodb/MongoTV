const express = require('express');
const { getDb } = require('../db/connection');
const { optionalAuth } = require('../middleware/auth');
const { searchCatalogHybrid } = require('../services/search/hybridSearch');

const router = express.Router();
const MIN_QUERY_LENGTH = 2;

function sanitizeQuery(rawValue) {
  return String(rawValue || '').trim().replace(/\s+/g, ' ');
}

router.use(optionalAuth);

router.get('/search', (req, res) => {
  const query = sanitizeQuery(req.query.q);
  return res.render('search', {
    title: 'Search',
    activePage: 'search',
    initialQuery: query,
  });
});

router.get('/api/search/suggest', async (req, res) => {
  try {
    const query = sanitizeQuery(req.query.q);
    if (!query || query.length < MIN_QUERY_LENGTH) {
      return res.json({
        query,
        suggestions: [],
        bestGuess: null,
        results: [],
      });
    }

    const db = await getDb();
    const limit = Number(req.query.limit) || 20;
    const payload = await searchCatalogHybrid(db, {
      queryText: query,
      limit,
    });
    return res.json(payload);
  } catch (err) {
    console.error('Search suggest error:', err);
    return res.status(500).json({
      error: 'Search is temporarily unavailable.',
      suggestions: [],
      bestGuess: null,
      results: [],
    });
  }
});

module.exports = router;
