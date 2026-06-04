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

module.exports = function handler(req, res) {
  if (loadError) {
    const payload = {
      error: 'app_failed_to_load',
      message: loadError.message || String(loadError),
      name: loadError.name || null,
      code: loadError.code || null,
      stack: String(loadError.stack || '').split('\n').slice(0, 25),
      node: process.version,
      cwd: process.cwd(),
      runtimeEnvKeys: Object.keys(process.env)
        .filter((k) => !/SECRET|KEY|TOKEN|PASSWORD|URI|DSN/i.test(k))
        .sort(),
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
