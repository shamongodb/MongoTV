// Vercel serverless entry point.
//
// We wrap the Express app require() in a try/catch so that *anything* thrown
// at module load (ESM/CJS mismatches, missing env vars asserted at load,
// LangGraph compile failures, etc.) is surfaced as a readable JSON response
// instead of an opaque FUNCTION_INVOCATION_FAILED. This is much faster to
// debug than scraping the Vercel runtime log UI. Once the deployment is
// stable we can drop this wrapper and go back to a one-line re-export.

let app = null;
let loadError = null;

try {
  app = require('../index.js');
} catch (err) {
  loadError = err;
  console.error('Failed to load Express app at module init:', err);
}

function safeReaddir(dir) {
  try {
    return require('fs').readdirSync(dir);
  } catch (err) {
    return `<readdir failed: ${err.code || err.message}>`;
  }
}

function safeReadJson(file) {
  try {
    return JSON.parse(require('fs').readFileSync(file, 'utf8'));
  } catch (err) {
    return `<read failed: ${err.code || err.message}>`;
  }
}

function deploymentInfo() {
  return {
    deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    commitMsg: process.env.VERCEL_GIT_COMMIT_MESSAGE || null,
    region: process.env.VERCEL_REGION || process.env.AWS_REGION || null,
    node: process.version,
  };
}

function uuidLayout() {
  const base = require('path').join(process.cwd(), 'node_modules');
  return {
    'node_modules/uuid/package.json': safeReadJson(
      require('path').join(base, 'uuid', 'package.json'),
    ),
    'node_modules/@langchain/langgraph-checkpoint': safeReaddir(
      require('path').join(base, '@langchain', 'langgraph-checkpoint'),
    ),
    'node_modules/@langchain/langgraph-checkpoint/node_modules': safeReaddir(
      require('path').join(base, '@langchain', 'langgraph-checkpoint', 'node_modules'),
    ),
  };
}

module.exports = function handler(req, res) {
  if (req.url === '/__diag') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify(
        {
          deployment: deploymentInfo(),
          loadError: loadError
            ? { message: loadError.message, code: loadError.code }
            : null,
          uuid: uuidLayout(),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (loadError) {
    const payload = {
      error: 'app_failed_to_load',
      message: loadError.message || String(loadError),
      name: loadError.name || null,
      code: loadError.code || null,
      stack: String(loadError.stack || '').split('\n').slice(0, 25),
      deployment: deploymentInfo(),
      uuid: uuidLayout(),
    };
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  try {
    return app(req, res);
  } catch (err) {
    console.error('Synchronous handler crash:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify(
        {
          error: 'handler_sync_throw',
          message: err?.message || String(err),
          stack: String(err?.stack || '').split('\n').slice(0, 25),
        },
        null,
        2,
      ),
    );
  }
};
