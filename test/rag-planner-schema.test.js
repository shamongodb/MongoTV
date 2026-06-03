const test = require('node:test');
const assert = require('node:assert/strict');
const { planSchema } = require('../src/services/rag/planner');

test('plan schema applies defaults for search plans', () => {
  const parsed = planSchema.parse({
    action: 'search',
    searchQuery: 'funny family movies',
  });

  assert.equal(parsed.action, 'search');
  assert.equal(parsed.topK, 5);
  assert.equal(parsed.searchQuery, 'funny family movies');
  assert.equal(parsed.clarificationQuestion, '');
});

test('plan schema rejects invalid topK', () => {
  assert.throws(
    () =>
      planSchema.parse({
        action: 'search',
        searchQuery: 'thriller',
        topK: 99,
      }),
    /Too big/
  );
});
