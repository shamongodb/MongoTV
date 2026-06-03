const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMatchStage,
  createMovieRetrieverTool,
  retrieveMovies,
} = require('../src/services/rag/retriever');

test('buildMatchStage builds regex/type and year range filters', () => {
  const matchStage = buildMatchStage({
    contentType: 'movie',
    yearFrom: 1990,
    yearTo: 2001,
  });

  assert.deepEqual(matchStage, {
    $match: {
      type: { $regex: '^movie$', $options: 'i' },
      year: { $gte: 1990, $lte: 2001 },
    },
  });
});

test('retrieveMovies executes vector pipeline with injected embedding dependency', async () => {
  let capturedPipeline = null;
  const db = {
    collection: () => ({
      aggregate: (pipeline) => {
        capturedPipeline = pipeline;
        return {
          toArray: async () => [{ title: 'Mock Title', score: 0.99 }],
        };
      },
    }),
  };

  const results = await retrieveMovies(db, {
    queryText: 'dark comedy',
    topK: 3,
    embedQueryFn: async () => [0.1, 0.2, 0.3],
    getIndexEmbeddingDimensionFn: async () => 3,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Mock Title');
  assert.equal(capturedPipeline[0].$vectorSearch.limit, 3);
  assert.deepEqual(capturedPipeline[0].$vectorSearch.queryVector, [0.1, 0.2, 0.3]);
});

test('createMovieRetrieverTool returns serialized docs payload', async () => {
  const db = {
    collection: () => ({
      aggregate: () => ({
        toArray: async () => [{ title: 'Tool Result' }],
      }),
    }),
  };
  const tool = createMovieRetrieverTool(db, {
    embedQueryFn: async () => [1, 2],
    getIndexEmbeddingDimensionFn: async () => 2,
  });

  const output = await tool.invoke({ queryText: 'mystery', topK: 1 });
  const parsed = JSON.parse(output);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.docs[0].title, 'Tool Result');
});
