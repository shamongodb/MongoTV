/**
 * Creates the Atlas Vector Search index on the embedded_movies collection (sample_mflix).
 * Uses the existing field: plot_embedding_voyage_3_large (1024 dimensions, voyage-3).
 *
 * Requires: MongoDB Atlas 7.0+ and createSearchIndexes privilege.
 * Run: node scripts/create-vector-index.js  (from project root)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { connect, getDb, close } = require('../src/db/connection');

const INDEX_NAME = 'content_vector_index';
const VECTOR_PATH = 'plot_embedding_voyage_3_large';
const NUM_DIMENSIONS = 1024; // voyage-3 / voyage-3-large default

async function createVectorIndex() {
  try {
    console.log('Connecting to MongoDB...');
    await connect();
    const db = await getDb();
    const collection = db.collection('embedded_movies');

    const description = {
      name: INDEX_NAME,
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: VECTOR_PATH,
            numDimensions: NUM_DIMENSIONS,
            similarity: 'cosine',
          },
        ],
      },
    };

    console.log(`Creating vector search index "${INDEX_NAME}" on ${VECTOR_PATH} (${NUM_DIMENSIONS}d)...`);
    const name = await collection.createSearchIndex(description);
    console.log(`Index "${name}" created. It may take a short time to become ready.`);
  } catch (err) {
    console.error('Error creating index:', err.message);
    if (err.code === 85 || err.message?.includes('already exists')) {
      console.log('Index already exists. Use Atlas UI or dropSearchIndex() to replace it.');
    }
    if (err.code === 72 || err.message?.includes('not supported')) {
      console.log('Vector search requires MongoDB Atlas 7.0+. Create the index in Atlas UI.');
    }
    process.exit(1);
  } finally {
    await close();
  }
}

createVectorIndex();
