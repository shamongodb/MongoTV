/**
 * Creates Atlas Search indexes for remote-friendly catalog search.
 * - content_title_autocomplete_index: title autocomplete + title exact text
 * - content_people_text_index: cast/directors/writers text search
 *
 * Requires MongoDB Atlas 7.0+ and createSearchIndexes privilege.
 * Run: node scripts/create-search-indexes.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { connect, getDb, close } = require('../src/db/connection');

const COLLECTION_NAME = 'embedded_movies';
const TITLE_INDEX_NAME = 'content_title_autocomplete_index';
const PEOPLE_INDEX_NAME = 'content_people_text_index';

async function ensureSearchIndex(collection, description) {
  try {
    console.log(`Creating search index "${description.name}"...`);
    const name = await collection.createSearchIndex(description);
    console.log(`Created "${name}". Atlas may take a short time to build the index.`);
  } catch (err) {
    if (err.code === 85 || err.message?.includes('already exists')) {
      console.log(`Index "${description.name}" already exists. Skipping.`);
      return;
    }
    throw err;
  }
}

async function createSearchIndexes() {
  try {
    console.log('Connecting to MongoDB...');
    await connect();
    const db = await getDb();
    const collection = db.collection(COLLECTION_NAME);

    await ensureSearchIndex(collection, {
      name: TITLE_INDEX_NAME,
      type: 'search',
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            title: [
              {
                type: 'autocomplete',
                minGrams: 2,
                maxGrams: 15,
                tokenization: 'edgeGram',
                foldDiacritics: true,
              },
              {
                type: 'string',
                analyzer: 'lucene.standard',
              },
            ],
          },
        },
      },
    });

    await ensureSearchIndex(collection, {
      name: PEOPLE_INDEX_NAME,
      type: 'search',
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            cast: { type: 'string', analyzer: 'lucene.standard' },
            directors: { type: 'string', analyzer: 'lucene.standard' },
            writers: { type: 'string', analyzer: 'lucene.standard' },
          },
        },
      },
    });

    console.log('Done creating search indexes.');
  } catch (err) {
    console.error('Error creating search indexes:', err.message);
    if (err.code === 72 || err.message?.includes('not supported')) {
      console.log('Atlas Search requires MongoDB Atlas. Create these indexes in the Atlas UI.');
    }
    process.exit(1);
  } finally {
    await close();
  }
}

createSearchIndexes();
