const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');

const { planRetrieval } = require('./planner');
const { retrieveMovies, DEFAULT_TOP_K } = require('./retriever');
const {
  synthesizeRecommendation,
  synthesizeDirectResponse,
  synthesizeRecommendationReasons,
  synthesizeVoiceSummary,
} = require('./synthesizer');

// ---------------------------------------------------------------------------
// State definition.
//
// Each annotation uses the default "replace" reducer (last write wins). This
// is safe here because each node writes to a *distinct* field, so parallel
// branches never contend for the same key.
//
// `db` is intentionally NOT in state — it's a non-serializable Mongo client.
// We thread it through `config.configurable.db` so the graph state stays
// JSON-friendly (a prerequisite if we ever add a Mongo checkpointer).
// ---------------------------------------------------------------------------
const RagState = Annotation.Root({
  // Inputs
  message: Annotation(),
  memoryContext: Annotation(),
  voiceMode: Annotation(),
  startedAt: Annotation(),

  // Plan / retrieval
  plan: Annotation(),
  queryText: Annotation(),
  topK: Annotation(),
  results: Annotation(),

  // Parallel synthesis outputs
  reasonsById: Annotation(),
  response: Annotation(),
  voiceSummary: Annotation(),

  // Terminal payload (what the caller actually consumes)
  output: Annotation(),
});

// ---------------------------------------------------------------------------
// Helpers used by the merge node.
// ---------------------------------------------------------------------------
function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripListPrefix(line) {
  return String(line || '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .trim();
}

function extractReasonsFromChatResponse(responseText, catalogTitles) {
  const lines = String(responseText || '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (!lines.length || !catalogTitles.size) return {};

  const reasonsByTitle = {};
  let index = 0;
  while (index < lines.length) {
    const current = stripListPrefix(lines[index]);
    const normalizedTitle = normalizeTitle(current);
    if (!catalogTitles.has(normalizedTitle)) {
      index += 1;
      continue;
    }

    const reasonLines = [];
    let scan = index + 1;
    while (scan < lines.length) {
      const probe = lines[scan];
      const strippedProbe = stripListPrefix(probe);
      const normalizedProbe = normalizeTitle(strippedProbe);
      if (!probe) {
        if (reasonLines.length) break;
        scan += 1;
        continue;
      }
      if (catalogTitles.has(normalizedProbe)) break;
      if (/^let me know\b/i.test(probe)) break;
      reasonLines.push(strippedProbe);
      scan += 1;
    }

    const reason = reasonLines.join('\n').trim();
    if (reason) reasonsByTitle[normalizedTitle] = reason;
    index = scan > index ? scan : index + 1;
  }

  return reasonsByTitle;
}

// ---------------------------------------------------------------------------
// Nodes. Each returns a partial state update.
// ---------------------------------------------------------------------------

async function planNode(state) {
  const plan = await planRetrieval(state.message, state.memoryContext);
  return { plan };
}

async function smalltalkNode(state) {
  const response = await synthesizeDirectResponse(state.message, state.memoryContext);
  return {
    output: {
      response:
        response || 'Tell me what you feel like watching and I can suggest options.',
      voiceSummary: '',
      results: [],
      meta: {
        mode: 'llm_direct',
        searched: false,
        resultCount: 0,
        latencyMs: Date.now() - state.startedAt,
      },
    },
  };
}

async function clarifyNode(state) {
  return {
    output: {
      response:
        state.plan?.clarificationQuestion ||
        'Do you want a movie or a series, and what mood are you in?',
      voiceSummary: '',
      results: [],
      meta: {
        mode: 'clarify',
        searched: false,
        resultCount: 0,
        latencyMs: Date.now() - state.startedAt,
      },
    },
  };
}

async function retrieveNode(state, config) {
  const db = config?.configurable?.db;
  if (!db) {
    throw new Error(
      'rag graph: db client missing from RunnableConfig.configurable.db',
    );
  }
  const plan = state.plan || {};
  const queryText =
    String(plan.searchQuery || state.message || '').trim() || state.message;
  const topK = Number.isInteger(plan.topK) ? plan.topK : DEFAULT_TOP_K;
  const results = await retrieveMovies(db, {
    queryText,
    topK,
    contentType: plan.contentType,
    yearFrom: plan.yearFrom,
    yearTo: plan.yearTo,
  });
  return { queryText, topK, results };
}

async function noResultsNode(state) {
  return {
    output: {
      response:
        'I could not find close matches yet. Try adding a genre, vibe, or an example title you like.',
      voiceSummary: '',
      results: [],
      meta: {
        mode: 'searched_no_results',
        searched: true,
        queryUsed: state.queryText,
        resultCount: 0,
        latencyMs: Date.now() - state.startedAt,
      },
    },
  };
}

async function reasonsNode(state) {
  try {
    const reasonsById = await synthesizeRecommendationReasons({
      userMessage: state.message,
      searchQuery: state.queryText,
      results: state.results,
      memoryContext: state.memoryContext,
    });
    return { reasonsById: reasonsById || {} };
  } catch (err) {
    // Non-fatal: per-item LLM reasons are best-effort.
    console.warn(
      'LLM recommendation reason generation failed:',
      err?.message || err,
    );
    return { reasonsById: {} };
  }
}

async function responseNode(state) {
  // Fatal: the final conversational reply is required for the chat turn.
  const response = await synthesizeRecommendation({
    userMessage: state.message,
    searchQuery: state.queryText,
    results: state.results,
    memoryContext: state.memoryContext,
  });
  return { response };
}

async function voiceNode(state) {
  // Always present in the graph topology so the merge node's rendezvous on
  // (reasons, response, voice) doesn't deadlock. We fast-path to an empty
  // summary when voice mode is off, paying no LLM cost.
  if (!state.voiceMode) return { voiceSummary: '' };
  try {
    const voiceSummary = await synthesizeVoiceSummary({
      userMessage: state.message,
      results: state.results,
      memoryContext: state.memoryContext,
    });
    return { voiceSummary: String(voiceSummary || '').trim() };
  } catch (err) {
    console.warn('Voice TL;DR generation failed:', err?.message || err);
    return { voiceSummary: '' };
  }
}

async function mergeNode(state) {
  const results = state.results || [];
  const reasonsById = state.reasonsById || {};
  const response = state.response || '';

  // First pass: stamp each result with its structured reason (if we got one).
  const resultsWithReasons = results.map((item) => {
    const id = item?._id ? String(item._id) : '';
    return {
      ...item,
      reason: id && reasonsById[id] ? reasonsById[id] : item.reason || '',
    };
  });

  // Second pass: when the chat response itself contains per-title pitches,
  // prefer those (they're already shown to the user verbatim).
  const titleSet = new Set(
    resultsWithReasons.map((item) => normalizeTitle(item?.title)).filter(Boolean),
  );
  const reasonsByTitle = extractReasonsFromChatResponse(response, titleSet);
  const syncedResults = resultsWithReasons.map((item) => {
    const parsedReason = reasonsByTitle[normalizeTitle(item?.title)];
    if (parsedReason) return { ...item, reason: parsedReason };
    return item;
  });

  const voiceSummary = String(state.voiceSummary || '').trim();

  return {
    output: {
      response: response || 'Here are a few strong matches from the catalog.',
      voiceSummary,
      results: syncedResults,
      meta: {
        mode: 'rag_search',
        searched: true,
        queryUsed: state.queryText,
        resultCount: results.length,
        voiceSummaryGenerated: !!voiceSummary,
        latencyMs: Date.now() - state.startedAt,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Routing.
// ---------------------------------------------------------------------------

function planRouter(state) {
  const action = state.plan?.action;
  if (action === 'smalltalk') return 'smalltalk';
  if (action === 'clarify') return 'clarify';
  return 'searchFanout';
}

function retrieveRouter(state) {
  if (!Array.isArray(state.results) || !state.results.length) {
    return 'noResults';
  }
  // Returning an array fans out: LangGraph dispatches all three nodes in
  // parallel. The `merge` node sits at the rendezvous of all three edges and
  // only fires once each has produced its update.
  return ['reasons', 'compose', 'voice'];
}

// ---------------------------------------------------------------------------
// Graph wiring.
//
//                              ┌──────────┐
//                              │ planner  │
//                              └────┬─────┘
//                                   │
//                          (planRouter)
//             ┌─────────────────────┼────────────────────┐
//             ▼                     ▼                    ▼
//        smalltalk              clarify              retrieve
//             │                     │                    │
//             ▼                     ▼          (retrieveRouter)
//            END                   END        ┌──────────┼──────────┐
//                                              ▼          ▼          ▼
//                                          reasons    compose     voice    noResults ──► END
//                                              └──────────┼──────────┘
//                                                         ▼
//                                                       merge
//                                                         ▼
//                                                        END
//
// Note on naming: node names must be distinct from state channel names.
// The `planner` node writes to the `plan` channel; the `compose` node writes
// to the `response` channel.
// ---------------------------------------------------------------------------
const builder = new StateGraph(RagState)
  .addNode('planner', planNode)
  .addNode('smalltalk', smalltalkNode)
  .addNode('clarify', clarifyNode)
  .addNode('retrieve', retrieveNode)
  .addNode('noResults', noResultsNode)
  .addNode('reasons', reasonsNode)
  .addNode('compose', responseNode)
  .addNode('voice', voiceNode)
  .addNode('merge', mergeNode)
  .addEdge(START, 'planner')
  .addConditionalEdges('planner', planRouter, {
    smalltalk: 'smalltalk',
    clarify: 'clarify',
    searchFanout: 'retrieve',
  })
  .addConditionalEdges('retrieve', retrieveRouter, {
    noResults: 'noResults',
    reasons: 'reasons',
    compose: 'compose',
    voice: 'voice',
  })
  .addEdge('reasons', 'merge')
  .addEdge('compose', 'merge')
  .addEdge('voice', 'merge')
  .addEdge('smalltalk', END)
  .addEdge('clarify', END)
  .addEdge('noResults', END)
  .addEdge('merge', END);

// Compile once at module load. Future enhancement: pass a checkpointer here
// (e.g. `MongoDBSaver` from `@langchain/langgraph-checkpoint-mongodb`) to
// persist intermediate state per `thread_id`. We deliberately skip that for
// now because conversation history is already persisted via the memory store
// and adding a second persistence layer is more cost than benefit today.
const ragGraph = builder.compile();

module.exports = {
  ragGraph,
  RagState,
};
