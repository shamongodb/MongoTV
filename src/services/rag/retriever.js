const { DynamicStructuredTool } = require('@langchain/core/tools');
const { z } = require('zod');
const { embedQuery } = require('../voyage');

const CONTENT_COLLECTION = 'embedded_movies';
const CONTENT_INDEX = 'content_vector_index';
const CONTENT_VECTOR_PATH = 'plot_embedding_voyage_3_large';
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;

async function getStoredEmbeddingDimension(collection) {
  const sampleDoc = await collection.findOne(
    { [CONTENT_VECTOR_PATH]: { $type: 'array' } },
    { projection: { [CONTENT_VECTOR_PATH]: 1 } }
  );
  const vector = sampleDoc?.[CONTENT_VECTOR_PATH];
  return Array.isArray(vector) ? vector.length : null;
}

async function getIndexEmbeddingDimension(collection) {
  try {
    const indexes = await collection.listSearchIndexes(CONTENT_INDEX).toArray();
    const fields = indexes?.[0]?.latestDefinition?.fields || indexes?.[0]?.definition?.fields || [];
    const vectorField = fields.find(
      (field) => field?.type === 'vector' && field?.path === CONTENT_VECTOR_PATH
    );
    if (typeof vectorField?.numDimensions === 'number') {
      return vectorField.numDimensions;
    }
  } catch {
    // Fall back to document vectors when index metadata cannot be read.
  }
  return getStoredEmbeddingDimension(collection);
}

function getModelCandidates() {
  const fromEnv = process.env.VOYAGE_MODEL;
  const fromFallbackEnv = (process.env.VOYAGE_FALLBACK_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([fromEnv, ...fromFallbackEnv, 'voyage-3-large', 'voyage-3', 'voyage-large-2'])];
}

async function buildQueryEmbedding(queryText, expectedDimension, embedQueryFn = embedQuery) {
  const models = getModelCandidates();
  const errors = [];

  for (const model of models) {
    try {
      const embedding = await embedQueryFn(queryText, {
        model,
        outputDimension: expectedDimension || undefined,
      });
      if (!expectedDimension || embedding.length === expectedDimension) {
        return embedding;
      }
      errors.push(
        `model=${model} produced ${embedding.length} dims, expected ${expectedDimension}`
      );
    } catch (err) {
      errors.push(`model=${model} failed: ${err?.message || 'unknown error'}`);
    }
  }

  throw new Error(
    `Unable to produce query embedding with expected dimension ${expectedDimension || 'unknown'}. ${errors.join('; ')}`
  );
}

function buildMatchStage({ contentType, yearFrom, yearTo }) {
  const match = {};

  if (typeof contentType === 'string' && contentType.trim()) {
    match.type = { $regex: `^${contentType.trim()}$`, $options: 'i' };
  }
  if (typeof yearFrom === 'number' || typeof yearTo === 'number') {
    match.year = {};
    if (typeof yearFrom === 'number') match.year.$gte = yearFrom;
    if (typeof yearTo === 'number') match.year.$lte = yearTo;
  }

  return Object.keys(match).length ? { $match: match } : null;
}

async function retrieveMovies(db, params) {
  const collection = db.collection(CONTENT_COLLECTION);
  const queryText = String(params.queryText || '').trim();
  if (!queryText) return [];

  const embedQueryFn = params.embedQueryFn || embedQuery;
  const getIndexEmbeddingDimensionFn =
    params.getIndexEmbeddingDimensionFn || getIndexEmbeddingDimension;
  const expectedDimension = await getIndexEmbeddingDimensionFn(collection);
  const queryVector = await buildQueryEmbedding(queryText, expectedDimension, embedQueryFn);
  const limit = Math.min(Math.max(params.topK || DEFAULT_TOP_K, 1), MAX_TOP_K);
  const matchStage = buildMatchStage(params);

  const pipeline = [
    {
      $vectorSearch: {
        index: CONTENT_INDEX,
        path: CONTENT_VECTOR_PATH,
        queryVector,
        numCandidates: Math.max(limit * 10, 50),
        limit,
      },
    },
    ...(matchStage ? [matchStage] : []),
    {
      $project: {
        title: 1,
        genre: 1,
        poster: 1,
        description: 1,
        plot: 1,
        type: 1,
        year: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  return collection.aggregate(pipeline, { maxTimeMS: 3500 }).toArray();
}

function createMovieRetrieverTool(db, deps = {}) {
  return new DynamicStructuredTool({
    name: 'search_catalog',
    description:
      'Search MongoTV catalog using vector similarity. Use for recommendation/search intent.',
    schema: z.object({
      queryText: z.string().min(1),
      topK: z.number().int().min(1).max(MAX_TOP_K).default(DEFAULT_TOP_K),
      contentType: z.enum(['movie', 'series']).optional(),
      yearFrom: z.number().int().optional(),
      yearTo: z.number().int().optional(),
    }),
    func: async (input) => {
      const docs = await retrieveMovies(db, {
        ...input,
        embedQueryFn: deps.embedQueryFn,
        getIndexEmbeddingDimensionFn: deps.getIndexEmbeddingDimensionFn,
      });
      return JSON.stringify({
        count: docs.length,
        docs,
      });
    },
  });
}

module.exports = {
  retrieveMovies,
  createMovieRetrieverTool,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  buildMatchStage,
};
