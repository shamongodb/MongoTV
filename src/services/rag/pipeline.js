const { ragGraph } = require('./graph');

/**
 * Run a single RAG chat turn through the LangGraph pipeline.
 *
 * The graph (see ./graph.js) handles:
 *   - planning (smalltalk vs clarify vs search)
 *   - vector retrieval
 *   - parallel fan-out for per-item reasons, the conversational reply, and
 *     (optionally) a short voice TL;DR
 *   - merging everything into the response shape the chat route expects
 *
 * The Mongo client is passed via RunnableConfig.configurable so graph state
 * stays JSON-serializable (a prerequisite if we later add a checkpointer).
 */
async function runRagChat({ db, message, memoryContext = {}, voiceMode = false }) {
  const initialState = {
    message: String(message || '').trim(),
    memoryContext: memoryContext || {},
    voiceMode: !!voiceMode,
    startedAt: Date.now(),
  };

  const finalState = await ragGraph.invoke(initialState, {
    configurable: { db },
    runName: 'rag_chat',
    tags: ['rag', voiceMode ? 'voice' : 'text'],
  });

  if (!finalState?.output) {
    // Defensive: every terminal node writes `output`. If we got here without
    // one, something in the graph wiring drifted.
    throw new Error('RAG graph produced no output');
  }

  return finalState.output;
}

module.exports = {
  runRagChat,
};
