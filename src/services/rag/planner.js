const { z } = require('zod');
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { getRagLlm } = require('./llm');
const { DEFAULT_TOP_K, MAX_TOP_K } = require('./retriever');

const planSchema = z.object({
  action: z.enum(['search', 'clarify', 'smalltalk']),
  searchQuery: z.string().default(''),
  topK: z.number().int().min(1).max(MAX_TOP_K).default(DEFAULT_TOP_K),
  contentType: z.enum(['movie', 'series']).optional(),
  yearFrom: z.number().int().optional(),
  yearTo: z.number().int().optional(),
  clarificationQuestion: z.string().default(''),
});

const plannerPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    [
      'You are a retrieval planner for a streaming catalog assistant.',
      'Return only structured JSON matching the schema.',
      'Decide whether to search the catalog or not.',
      'Use action=search for recommendation or content discovery requests.',
      'Use action=clarify when user intent is content-related but ambiguous.',
      'Use action=smalltalk for non-catalog conversational turns.',
      'When action=search, rewrite searchQuery to be semantically rich and concise.',
      `When action=search, choose topK between 1 and ${MAX_TOP_K}.`,
      'Use conversation and long-term memory context when available.',
      'If the latest user turn is a follow-up, resolve references using conversation context.',
    ].join('\n'),
  ],
  [
    'human',
    [
      'Conversation summary:',
      '{rollingSummary}',
      '',
      'Recent conversation turns:',
      '{recentTurns}',
      '',
      'Known user preferences and constraints:',
      '{longTermMemory}',
      '',
      'Latest user message:',
      '{message}',
    ].join('\n'),
  ],
]);

function formatRecentTurns(recentMessages) {
  if (!Array.isArray(recentMessages) || !recentMessages.length) return 'None';
  return recentMessages
    .map((item) => `${item.role || 'user'}: ${String(item.content || '').trim()}`)
    .join('\n');
}

function formatLongTermMemory(longTermMemories) {
  if (!Array.isArray(longTermMemories) || !longTermMemories.length) return 'None';
  return longTermMemories
    .map((item) => {
      const type = item.memoryType || 'preference';
      const confidence =
        typeof item.confidence === 'number' ? ` (confidence ${item.confidence.toFixed(2)})` : '';
      return `- [${type}] ${item.text || ''}${confidence}`;
    })
    .join('\n');
}

async function planRetrieval(message, memoryContext = {}) {
  const llm = getRagLlm();
  const structuredLlm = llm.withStructuredOutput(planSchema, {
    name: 'catalog_retrieval_plan',
  });
  const chain = plannerPrompt.pipe(structuredLlm);
  const contextPayload = {
    message: String(message || '').trim(),
    rollingSummary: memoryContext?.rollingSummary || 'None',
    recentTurns: formatRecentTurns(memoryContext?.recentMessages),
    longTermMemory: formatLongTermMemory(memoryContext?.longTermMemories),
  };
  const plan = await chain.invoke(contextPayload);
  return planSchema.parse(plan);
}

module.exports = {
  planRetrieval,
  planSchema,
};
