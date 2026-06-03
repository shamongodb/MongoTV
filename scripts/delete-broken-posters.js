require('dotenv').config();
const { connect, getDb, close } = require('../src/db/connection');

const COLLECTION = process.env.POSTER_COLLECTION || 'embedded_movies';
const POSTER_FIELD = process.env.POSTER_FIELD || 'poster';
const CONCURRENCY = Number(process.env.POSTER_CHECK_CONCURRENCY || 10);
const TIMEOUT_MS = Number(process.env.POSTER_CHECK_TIMEOUT_MS || 8000);
const isApplyMode = process.argv.includes('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 0;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timeout);
  }
}

function contentTypeIsImage(response) {
  const contentType = response.headers.get('content-type') || '';
  return contentType.toLowerCase().startsWith('image/');
}

async function posterUrlLooksValid(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'missing_url' };
  }

  try {
    const headResponse = await fetchWithTimeout(url, { method: 'HEAD' });
    if (headResponse.ok && contentTypeIsImage(headResponse)) {
      return { ok: true, reason: 'head_image_ok' };
    }

    if (headResponse.status !== 405) {
      return { ok: false, reason: `head_${headResponse.status}` };
    }

    // Some CDNs reject HEAD requests; fallback to a lightweight GET check.
    const getResponse = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });

    if (getResponse.ok && contentTypeIsImage(getResponse)) {
      return { ok: true, reason: 'get_image_ok' };
    }
    return { ok: false, reason: `get_${getResponse.status}` };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.name ? error.name : 'request_error',
    };
  }
}

async function run() {
  await connect();
  const db = await getDb();
  const collection = db.collection(COLLECTION);

  const query = {
    [POSTER_FIELD]: { $exists: true, $ne: null, $type: 'string' },
  };
  const options = {
    projection: { _id: 1, title: 1, [POSTER_FIELD]: 1 },
  };

  let cursor = collection.find(query, options);
  if (LIMIT > 0) cursor = cursor.limit(LIMIT);

  const docs = await cursor.toArray();
  console.log(
    `Checking ${docs.length} records in "${COLLECTION}" using field "${POSTER_FIELD}"...`
  );

  const brokenDocs = [];
  const reasonCounts = {};
  let index = 0;

  async function worker() {
    while (index < docs.length) {
      const currentIndex = index++;
      const doc = docs[currentIndex];
      const posterUrl = doc[POSTER_FIELD];
      const result = await posterUrlLooksValid(posterUrl);

      if (!result.ok) {
        brokenDocs.push({
          _id: doc._id,
          title: doc.title || '(untitled)',
          poster: posterUrl,
          reason: result.reason,
        });
        reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1;
      }

      if ((currentIndex + 1) % 100 === 0 || currentIndex + 1 === docs.length) {
        console.log(`Progress: ${currentIndex + 1}/${docs.length}`);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker());
  await Promise.all(workers);

  console.log(`\nFound ${brokenDocs.length} records with broken/non-image poster URLs.`);
  if (Object.keys(reasonCounts).length > 0) {
    console.log('Reason breakdown:', reasonCounts);
  }

  if (brokenDocs.length > 0) {
    const preview = brokenDocs.slice(0, 20).map((d) => ({
      _id: d._id,
      title: d.title,
      reason: d.reason,
      poster: d.poster,
    }));
    console.log('Sample records (up to 20):');
    console.table(preview);
  }

  if (!isApplyMode) {
    console.log('\nDry run only. No documents were deleted.');
    console.log('Run with --apply to delete the broken records.');
    return;
  }

  if (brokenDocs.length === 0) {
    console.log('No records to delete.');
    return;
  }

  const ids = brokenDocs.map((doc) => doc._id);
  const result = await collection.deleteMany({ _id: { $in: ids } });
  console.log(`Deleted ${result.deletedCount} records from "${COLLECTION}".`);
}

run()
  .catch((error) => {
    console.error('Failed to clean broken poster records:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close();
  });
