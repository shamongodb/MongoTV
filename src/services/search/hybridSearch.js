const { embedQuery } = require('../voyage');

const CONTENT_COLLECTION = 'embedded_movies';
const TITLE_INDEX = 'content_title_autocomplete_index';
const PEOPLE_INDEX = 'content_people_text_index';
const VECTOR_INDEX = 'content_vector_index';
const VECTOR_PATH = 'plot_embedding_voyage_3_large';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;
const RRF_K = 60;
const TITLE_WEIGHT = 0.7;
const VECTOR_WEIGHT = 0.2;
const PEOPLE_WEIGHT = 0.1;

function buildRankingWeights() {
  return {
    titleWeight: TITLE_WEIGHT,
    vectorWeight: VECTOR_WEIGHT,
    peopleWeight: PEOPLE_WEIGHT,
    rrfK: RRF_K,
  };
}

function clampLimit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_LIMIT);
}

function toDocId(value) {
  if (!value) return null;
  try {
    return String(value);
  } catch {
    return null;
  }
}

function projectSearchResult(doc) {
  const id = toDocId(doc?._id);
  if (!id) return null;
  return {
    _id: id,
    title: typeof doc.title === 'string' ? doc.title : 'Untitled',
    year: typeof doc.year === 'number' ? doc.year : null,
    poster: typeof doc.poster === 'string' ? doc.poster : '',
    type: typeof doc.type === 'string' ? doc.type : '',
    genre: typeof doc.genre === 'string' ? doc.genre : '',
    description:
      typeof doc.description === 'string'
        ? doc.description
        : typeof doc.plot === 'string'
          ? doc.plot
          : '',
    plot: typeof doc.plot === 'string' ? doc.plot : '',
  };
}

async function getVectorDimension(collection) {
  try {
    const indexes = await collection.listSearchIndexes(VECTOR_INDEX).toArray();
    const fields = indexes?.[0]?.latestDefinition?.fields || indexes?.[0]?.definition?.fields || [];
    const vectorField = fields.find((field) => field?.type === 'vector' && field?.path === VECTOR_PATH);
    if (typeof vectorField?.numDimensions === 'number') {
      return vectorField.numDimensions;
    }
  } catch {
    // Atlas metadata access can fail when privileges are limited.
  }

  const sampleDoc = await collection.findOne(
    { [VECTOR_PATH]: { $type: 'array' } },
    { projection: { [VECTOR_PATH]: 1 } }
  );
  const vector = sampleDoc?.[VECTOR_PATH];
  return Array.isArray(vector) ? vector.length : null;
}

function buildTitlePipeline(queryText, limit) {
  return [
    {
      $search: {
        index: TITLE_INDEX,
        compound: {
          should: [
            {
              phrase: {
                query: queryText,
                path: 'title',
                slop: 1,
              },
              score: { boost: { value: 12 } },
            },
            {
              text: {
                query: queryText,
                path: 'title',
                fuzzy: {
                  maxEdits: 1,
                  prefixLength: 1,
                  maxExpansions: 64,
                },
              },
              score: { boost: { value: 8 } },
            },
            {
              autocomplete: {
                query: queryText,
                path: 'title',
                tokenOrder: 'sequential',
                fuzzy: {
                  maxEdits: 1,
                  prefixLength: 1,
                  maxExpansions: 64,
                },
              },
              score: { boost: { value: 5 } },
            },
          ],
          minimumShouldMatch: 1,
        },
      },
    },
    {
      $project: {
        _id: 1,
        title: 1,
        year: 1,
        poster: 1,
        type: 1,
        genre: 1,
        description: 1,
        plot: 1,
        score: { $meta: 'searchScore' },
      },
    },
    { $limit: limit },
  ];
}

function buildPeoplePipeline(queryText, limit) {
  return [
    {
      $search: {
        index: PEOPLE_INDEX,
        compound: {
          should: [
            { text: { query: queryText, path: 'cast' }, score: { boost: { value: 4 } } },
            { text: { query: queryText, path: 'directors' }, score: { boost: { value: 3 } } },
            { text: { query: queryText, path: 'writers' }, score: { boost: { value: 2 } } },
          ],
          minimumShouldMatch: 1,
        },
      },
    },
    {
      $project: {
        _id: 1,
        title: 1,
        year: 1,
        poster: 1,
        type: 1,
        genre: 1,
        description: 1,
        plot: 1,
        score: { $meta: 'searchScore' },
      },
    },
    { $limit: limit },
  ];
}

function buildVectorPipeline(queryVector, limit) {
  return [
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: VECTOR_PATH,
        queryVector,
        numCandidates: Math.max(limit * 10, 80),
        limit,
      },
    },
    {
      $project: {
        _id: 1,
        title: 1,
        year: 1,
        poster: 1,
        type: 1,
        genre: 1,
        description: 1,
        plot: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];
}

function getBestComponentRank(componentScores) {
  const ranks = Object.values(componentScores || {})
    .map((entry) => entry?.rank)
    .filter((rank) => Number.isFinite(rank));
  if (!ranks.length) return Number.POSITIVE_INFINITY;
  return Math.min(...ranks);
}

function compareByFusedScoreDesc(a, b) {
  const scoreDelta = (b?.fusedScore || 0) - (a?.fusedScore || 0);
  if (Math.abs(scoreDelta) > 1e-12) return scoreDelta;

  // Deterministic tie-breaker: prefer stronger rank in any component list.
  const rankDelta = getBestComponentRank(a?.componentScores) - getBestComponentRank(b?.componentScores);
  if (rankDelta !== 0) return rankDelta;

  return String(a?._id || '').localeCompare(String(b?._id || ''));
}

function rankFuseLists(titleDocs, vectorDocs, peopleDocs, limit) {
  const merged = new Map();
  const weightedLists = [
    { docs: titleDocs, weight: TITLE_WEIGHT, key: 'title' },
    { docs: vectorDocs, weight: VECTOR_WEIGHT, key: 'vector' },
    { docs: peopleDocs, weight: PEOPLE_WEIGHT, key: 'people' },
  ];

  for (const list of weightedLists) {
    list.docs.forEach((doc, rank) => {
      const normalized = projectSearchResult(doc);
      if (!normalized) return;
      const id = normalized._id;
      if (!merged.has(id)) {
        merged.set(id, {
          ...normalized,
          fusedScore: 0,
          componentScores: {},
        });
      }
      const record = merged.get(id);
      const rrfScore = list.weight * (1 / (rank + 1 + RRF_K));
      record.fusedScore += rrfScore;
      record.componentScores[list.key] = {
        rank: rank + 1,
        sourceScore: typeof doc.score === 'number' ? Number(doc.score.toFixed(6)) : null,
        rrfScore: Number(rrfScore.toFixed(8)),
      };
    });
  }

  return Array.from(merged.values())
    .sort(compareByFusedScoreDesc)
    .slice(0, limit);
}

function buildSuggestions(titleDocs) {
  const seen = new Set();
  const suggestions = [];
  for (const doc of titleDocs) {
    const title = typeof doc?.title === 'string' ? doc.title.trim() : '';
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(title);
    if (suggestions.length >= 6) break;
  }
  return suggestions;
}

async function searchCatalogHybrid(db, params = {}) {
  const queryText = String(params.queryText || '').trim();
  if (!queryText) {
    return {
      query: '',
      weights: buildRankingWeights(),
      suggestions: [],
      bestGuess: null,
      results: [],
    };
  }

  const limit = clampLimit(params.limit);
  const collection = db.collection(CONTENT_COLLECTION);
  const expandedLimit = Math.min(limit * 2, MAX_LIMIT);

  const titlePromise = collection
    .aggregate(buildTitlePipeline(queryText, expandedLimit), { maxTimeMS: 2500 })
    .toArray()
    .catch(() => []);

  const peoplePromise = collection
    .aggregate(buildPeoplePipeline(queryText, expandedLimit), { maxTimeMS: 2500 })
    .toArray()
    .catch(() => []);

  const vectorPromise = (async () => {
    const expectedDimension = await getVectorDimension(collection);
    const queryVector = await embedQuery(queryText, {
      outputDimension: expectedDimension || undefined,
    });
    return collection
      .aggregate(buildVectorPipeline(queryVector, expandedLimit), { maxTimeMS: 3500 })
      .toArray();
  })().catch(() => []);

  const [titleDocs, peopleDocs, vectorDocs] = await Promise.all([
    titlePromise,
    peoplePromise,
    vectorPromise,
  ]);

  const fused = rankFuseLists(titleDocs, vectorDocs, peopleDocs, limit);
  const results = fused.map((item) => ({
    _id: item._id,
    title: item.title,
    year: item.year,
    poster: item.poster,
    type: item.type,
    genre: item.genre,
    description: item.description || item.plot,
    score: Number(item.fusedScore.toFixed(8)),
    componentScores: item.componentScores,
  }))
    // Keep response ordering explicitly aligned to highest total score first.
    .sort((a, b) => b.score - a.score);

  return {
    query: queryText,
    weights: buildRankingWeights(),
    suggestions: buildSuggestions(titleDocs),
    bestGuess: results[0] || null,
    results,
  };
}

module.exports = {
  searchCatalogHybrid,
};
