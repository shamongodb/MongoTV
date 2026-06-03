const express = require('express');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/connection');

const router = express.Router();
const MAX_GENRE_ROWS = 15;
const MAX_ITEMS_PER_ROW = 15;
const CONTENT_VECTOR_INDEX = 'content_vector_index';
const RECOMMENDATION_LIMIT = 12;
const BROWSE_PROJECTION = {
  _id: 1,
  title: 1,
  year: 1,
  poster: 1,
  genre: 1,
  genres: 1,
  listed_in: 1,
  category: 1,
  categories: 1,
};

function parseGenreValue(value) {
  if (Array.isArray(value)) {
    return value.map((g) => String(g).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((g) => g.trim()).filter(Boolean);
  }
  return [];
}

function parseListValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function formatRuntime(runtime) {
  if (typeof runtime !== 'number' || Number.isNaN(runtime) || runtime <= 0) return null;
  const hours = Math.floor(runtime / 60);
  const minutes = runtime % 60;
  if (!hours) return `${minutes} min`;
  if (!minutes) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function normalizeItemForDetail(item) {
  const parsedGenres = parseListValue(item.genres);
  const genres = parsedGenres.length ? parsedGenres : parseListValue(item.genre);
  const languages = parseListValue(item.languages);
  const countries = parseListValue(item.countries);
  const cast = parseListValue(item.cast);
  const directors = parseListValue(item.directors);
  const writers = parseListValue(item.writers);

  return {
    title: item.title || 'Untitled',
    type: item.type || null,
    year: item.year || null,
    rated: item.rated || null,
    runtime: formatRuntime(item.runtime),
    released: formatDate(item.released),
    genres,
    languages,
    countries,
    plot: item.plot || item.description || null,
    fullplot: item.fullplot || null,
    cast,
    directors,
    writers,
    awardsText: item.awards?.text || null,
    imdbRating: typeof item.imdb?.rating === 'number' ? item.imdb.rating : null,
    imdbVotes: typeof item.imdb?.votes === 'number' ? item.imdb.votes : null,
    tomatoesViewerRating:
      typeof item.tomatoes?.viewer?.rating === 'number' ? item.tomatoes.viewer.rating : null,
    tomatoesViewerMeter:
      typeof item.tomatoes?.viewer?.meter === 'number' ? item.tomatoes.viewer.meter : null,
    tomatoesViewerReviews:
      typeof item.tomatoes?.viewer?.numReviews === 'number'
        ? item.tomatoes.viewer.numReviews
        : null,
  };
}

async function runRecommendationSearch(collection, queryVector, currentId) {
  return collection
    .aggregate([
      {
        $vectorSearch: {
          index: CONTENT_VECTOR_INDEX,
          path: 'plot_embedding_voyage_3_large',
          queryVector,
          numCandidates: 100,
          limit: RECOMMENDATION_LIMIT + 1,
        },
      },
      {
        $match: {
          _id: { $ne: currentId },
        },
      },
      {
        $project: {
          _id: 1,
          title: 1,
          year: 1,
          poster: 1,
          type: 1,
          genres: 1,
          genre: 1,
          plot: 1,
          description: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
      {
        $limit: RECOMMENDATION_LIMIT,
      },
    ], { maxTimeMS: 2500 })
    .toArray();
}

router.get('/content/:id', async (req, res) => {
  try {
    const db = await getDb();
    const collection = db.collection('embedded_movies');
    let doc;
    try {
      doc = await collection.findOne({ _id: new ObjectId(req.params.id) });
    } catch {
      doc = null;
    }
    if (!doc) return res.status(404).render('error', { message: 'Content not found' });

    let recommendedItems = [];
    if (doc.plot_embedding_voyage_3_large) {
      try {
        recommendedItems = await runRecommendationSearch(
          collection,
          doc.plot_embedding_voyage_3_large,
          doc._id
        );
      } catch (recommendationErr) {
        const isDimensionMismatch = recommendationErr?.message?.includes(
          'vector field is indexed with'
        );
        if (isDimensionMismatch) {
          // Skip recommendations when index and vector dimensions disagree.
          // This avoids waiting on external embedding calls during page render.
          recommendedItems = [];
          console.error('Recommendation skipped due to vector dimension mismatch.');
        } else {
          console.error('Recommendation query error:', recommendationErr);
        }
      }
    }

    res.render('content-detail', {
      item: doc,
      detail: normalizeItemForDetail(doc),
      recommendedItems,
      title: doc.title,
    });
  } catch (err) {
    console.error('Content detail error:', err);
    res.status(500).render('error', { message: 'Failed to load content' });
  }
});

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const content = await db
      .collection('embedded_movies')
      .find({}, { projection: BROWSE_PROJECTION })
      .toArray();
    const byGenre = {};
    for (const item of content) {
      const genresForItem = [
        ...parseGenreValue(item.genre),
        ...parseGenreValue(item.genres),
        ...parseGenreValue(item.listed_in),
        ...parseGenreValue(item.category),
        ...parseGenreValue(item.categories)
      ];

      const normalizedGenres = genresForItem.length > 0 ? genresForItem : ['Other'];
      for (const genre of new Set(normalizedGenres)) {
        if (!byGenre[genre]) byGenre[genre] = [];
        byGenre[genre].push(item);
      }
    }
    const genres = Object.keys(byGenre).sort();
    const genreRows = genres
      .slice(0, MAX_GENRE_ROWS)
      .map((genre) => ({ genre, items: byGenre[genre].slice(0, MAX_ITEMS_PER_ROW) }));
    res.render('browse', { genreRows, title: 'Home', loadWarning: null });
  } catch (err) {
    console.error('Browse error:', err);
    res.render('browse', {
      genreRows: [],
      title: 'Home',
      loadWarning: 'Catalog is temporarily unavailable. Check MongoDB connection and refresh.',
    });
  }
});

module.exports = router;
