const VoyageAI = require('voyageai');

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const MODEL = process.env.VOYAGE_MODEL || 'voyage-3';

let client = null;

function getClient() {
  if (!client) {
    if (!VOYAGE_API_KEY) {
      throw new Error('VOYAGE_API_KEY is required for VoyageAI embeddings');
    }
    client = new VoyageAI.VoyageAIClient({ apiKey: VOYAGE_API_KEY });
  }
  return client;
}

function extractEmbeddingItems(response) {
  if (!response) return [];
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.data?.data)) return response.data.data;
  if (Array.isArray(response?.embeddings)) return response.embeddings;
  if (Array.isArray(response?.data?.embeddings)) return response.data.embeddings;
  if (Array.isArray(response?.body?.data)) return response.body.data;
  return [];
}

/**
 * Get embedding for a single string (for queries).
 * @param {string} text
 * @param {{ model?: string, outputDimension?: number }} [options]
 * @returns {Promise<number[]>}
 */
async function embedQuery(text, options = {}) {
  const voyage = getClient();
  const model = options.model || MODEL;
  const outputDimension =
    typeof options.outputDimension === 'number' && options.outputDimension > 0
      ? options.outputDimension
      : undefined;
  const response = await voyage.embed({
    input: text,
    model,
    inputType: 'query',
    outputDimension,
  });
  const items = extractEmbeddingItems(response);
  const first = items[0];
  const embedding = Array.isArray(first?.embedding)
    ? first.embedding
    : Array.isArray(first)
      ? first
      : null;
  if (!embedding) {
    throw new Error('No embedding returned from VoyageAI');
  }
  return embedding;
}

/**
 * Get embeddings for multiple strings (for documents during ingest).
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedDocuments(texts) {
  if (!texts.length) return [];
  const voyage = getClient();
  const response = await voyage.embed({
    input: texts,
    model: MODEL,
    inputType: 'document',
  });
  const items = extractEmbeddingItems(response);
  if (!items.length) throw new Error('No embeddings returned');
  return items.map((item) => item.embedding).filter(Array.isArray);
}

/**
 * Get a single document embedding (convenience for one string).
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedDocument(text) {
  const [vec] = await embedDocuments([text]);
  return vec;
}

module.exports = {
  embedQuery,
  embedDocuments,
  embedDocument,
};
