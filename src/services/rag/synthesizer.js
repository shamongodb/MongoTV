const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { z } = require('zod');
const { getRagLlm } = require('./llm');

const synthesisPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    [
      'You are MongoTV Guide, a grounded recommendation assistant.',
      'Use only the provided catalog results.',
      'Do not invent titles, years, or metadata.',
      'Keep responses concise and practical.',
      'Format as plain text with short bullets when listing recommendations.',
      'Use conversation and user memory context to personalize reasoning.',
      'If the user asks a follow-up question, answer it with prior turns in mind.',
      'For each recommended movie, include a 2-line sales pitch tailored to the user.',
      'Line 1: why it matches the user\'s stated mood/preferences from conversation context.',
      'Line 2: a concrete story hook from the catalog description/plot that sells the watch.',
      'Do not use generic lead-ins like "good fit" without specifics.',
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
      'User request:',
      '{userMessage}',
      '',
      'Search query used:',
      '{searchQuery}',
      '',
      'Catalog results JSON:',
      '{resultsJson}',
      '',
      'Summarize what the user seems to want and recommend the best matching options.',
      'If results are weak, say that and suggest a clarifying follow-up.',
    ].join('\n'),
  ],
]);

const recommendationReasonsPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    [
      'You are MongoTV Guide.',
      'Generate one persuasive reason per catalog item explaining why it matches the user request.',
      'Use only provided catalog fields and conversation context.',
      'Do not invent metadata.',
      'Return STRICT JSON only (no markdown) as an array of objects:',
      '[{{"id":"<catalog id>","reason":"<one sentence>"}}]',
      'Each reason must be exactly 2 lines separated by a newline character.',
      'Format reason as: "<line 1>\\n<line 2>".',
      'Each reason must include BOTH:',
      '- why it matches the user request/mood',
      '- one concrete story hook from the item description/plot',
      'Make each item distinct in wording; do not repeat the same template across items.',
      'Avoid generic phrasing like "good fit" without specifics.',
      'Do NOT use boilerplate openers such as "chosen to match", "picked for your request", or similar repeated lead-ins.',
      'Write each reason like a mini sales pitch that feels natural and specific to that title.',
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
      'User request:',
      '{userMessage}',
      '',
      'Search query used:',
      '{searchQuery}',
      '',
      'Catalog results JSON:',
      '{resultsJson}',
      '',
      'Output JSON array with one reason per result item id.',
    ].join('\n'),
  ],
]);

const directResponsePrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    [
      'You are MongoTV Guide.',
      'For non-search turns, respond briefly and steer the user toward content preferences when relevant.',
      'Do not claim you searched the catalog unless retrieval happened.',
      'Use memory context to stay coherent with recent turns.',
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
      '{userMessage}',
    ].join('\n'),
  ],
]);

const voiceSummaryPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    [
      'You are MongoTV Guide writing a SHORT spoken TL;DR for a text-to-speech voice agent.',
      'Write in a warm, conversational tone — like talking to a friend, not reading a list.',
      'Use ONLY the provided catalog results. Do not invent titles, years, or facts.',
      'Constraints:',
      '- 2 to 5 sentences total. Aim for under 60 spoken words.',
      '- Mention every title by name exactly once, in catalog order.',
      '- Give each title ONE short clause (5-10 words) describing the vibe or hook.',
      '- Do not list bullet points, numbers, or markdown. Plain prose only.',
      '- Do not say "here is a list" or read scores, IDs, or year numbers out loud.',
      '- End with a short, natural prompt to pick one, e.g. "Want to dive into one?".',
      'Output ONLY the spoken sentences. No preamble, no quotes, no formatting.',
    ].join('\n'),
  ],
  [
    'human',
    [
      'User request:',
      '{userMessage}',
      '',
      'Catalog results JSON (use only these titles, in this order):',
      '{resultsJson}',
      '',
      'Recent conversation turns (for tone, not facts):',
      '{recentTurns}',
      '',
      'Speak a quick, friendly TL;DR of these picks.',
    ].join('\n'),
  ],
]);

const recommendationReasonSchema = z.object({
  id: z.string(),
  line1: z.string().optional(),
  line2: z.string().optional(),
  reason: z.string().optional(),
});

const recommendationReasonsSchema = z.array(recommendationReasonSchema);

function formatCatalogResults(results) {
  return results.map((item) => ({
    id: item._id ? String(item._id) : null,
    title: item.title || null,
    type: item.type || null,
    genre: item.genre || null,
    year: item.year || null,
    description: item.description || item.plot || null,
    score: item.score || null,
  }));
}

function extractJsonText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return '[]';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : text;
}

function toSentence(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (/[.!?]$/.test(normalized)) return normalized;
  return `${normalized}.`;
}

function toTwoLinePitch(reasonText) {
  const raw = String(reasonText || '').trim();
  if (!raw) return '';
  const splitByLine = raw
    .split(/\r?\n+/)
    .map((line) => toSentence(line))
    .filter(Boolean);
  if (splitByLine.length >= 2) {
    return `${splitByLine[0]}\n${splitByLine[1]}`;
  }
  const normalized = toSentence(raw);
  if (!normalized) return '';
  const sentenceParts = normalized.match(/[^.!?]+[.!?]/g) || [normalized];
  const firstLine = toSentence(sentenceParts[0]);
  const secondLine = toSentence(sentenceParts.slice(1).join(' ')) || firstLine;
  return `${firstLine}\n${secondLine}`;
}

function parseRecommendationReasons(rawText) {
  try {
    const parsed = JSON.parse(extractJsonText(rawText));
    if (!Array.isArray(parsed)) return {};
    const byId = {};
    for (const entry of parsed) {
      const id = String(entry?.id || '').trim();
      const reason = toTwoLinePitch(entry?.reason);
      if (!id || !reason) continue;
      byId[id] = reason;
    }
    return byId;
  } catch {
    return {};
  }
}

function parseStructuredRecommendationReasons(entries) {
  if (!Array.isArray(entries)) return {};
  const byId = {};
  for (const entry of entries) {
    const id = String(entry?.id || '').trim();
    if (!id) continue;
    const line1 = toSentence(entry?.line1);
    const line2 = toSentence(entry?.line2);
    const joined = line1 && line2 ? `${line1}\n${line2}` : '';
    const fallback = toTwoLinePitch(entry?.reason);
    const reason = joined || fallback;
    if (!reason) continue;
    byId[id] = reason;
  }
  return byId;
}

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
      return `- [${type}] ${String(item.text || '').trim()}`;
    })
    .join('\n');
}

async function synthesizeRecommendation({
  userMessage,
  searchQuery,
  results,
  memoryContext = {},
}) {
  const llm = getRagLlm();
  const chain = synthesisPrompt.pipe(llm);
  const aiMessage = await chain.invoke({
    userMessage,
    searchQuery,
    resultsJson: JSON.stringify(formatCatalogResults(results)),
    rollingSummary: memoryContext?.rollingSummary || 'None',
    recentTurns: formatRecentTurns(memoryContext?.recentMessages),
    longTermMemory: formatLongTermMemory(memoryContext?.longTermMemories),
  });
  return String(aiMessage.content || '').trim();
}

async function synthesizeVoiceSummary({
  userMessage,
  results,
  memoryContext = {},
}) {
  if (!Array.isArray(results) || !results.length) return '';
  const llm = getRagLlm();
  const chain = voiceSummaryPrompt.pipe(llm);
  const aiMessage = await chain.invoke({
    userMessage,
    resultsJson: JSON.stringify(formatCatalogResults(results)),
    recentTurns: formatRecentTurns(memoryContext?.recentMessages),
  });
  return String(aiMessage.content || '').replace(/\s+/g, ' ').trim();
}

async function synthesizeDirectResponse(userMessage, memoryContext = {}) {
  const llm = getRagLlm();
  const chain = directResponsePrompt.pipe(llm);
  const aiMessage = await chain.invoke({
    userMessage,
    rollingSummary: memoryContext?.rollingSummary || 'None',
    recentTurns: formatRecentTurns(memoryContext?.recentMessages),
    longTermMemory: formatLongTermMemory(memoryContext?.longTermMemories),
  });
  return String(aiMessage.content || '').trim();
}

async function synthesizeRecommendationReasons({
  userMessage,
  searchQuery,
  results,
  memoryContext = {},
}) {
  if (!Array.isArray(results) || !results.length) return {};
  const llm = getRagLlm();
  const payload = {
    userMessage,
    searchQuery,
    resultsJson: JSON.stringify(formatCatalogResults(results)),
    rollingSummary: memoryContext?.rollingSummary || 'None',
    recentTurns: formatRecentTurns(memoryContext?.recentMessages),
    longTermMemory: formatLongTermMemory(memoryContext?.longTermMemories),
  };

  // Try structured output first. If the call succeeds we accept the result
  // (even an empty one) and DO NOT issue a second raw LLM call — doing so
  // doubled latency for every search-mode turn.
  let structuredCallFailed = false;
  try {
    const structuredLlm = llm.withStructuredOutput(recommendationReasonsSchema, {
      name: 'recommendation_reasons',
    });
    const structuredChain = recommendationReasonsPrompt.pipe(structuredLlm);
    const structuredResult = await structuredChain.invoke(payload);
    return parseStructuredRecommendationReasons(structuredResult);
  } catch (err) {
    structuredCallFailed = true;
    console.warn(
      'Structured recommendation reasons call failed, falling back to raw chain:',
      err?.message || err,
    );
  }

  // Only reachable if structured output is unsupported / errored out.
  if (!structuredCallFailed) return {};
  const chain = recommendationReasonsPrompt.pipe(llm);
  const aiMessage = await chain.invoke(payload);
  return parseRecommendationReasons(aiMessage.content);
}

module.exports = {
  synthesizeRecommendation,
  synthesizeDirectResponse,
  synthesizeRecommendationReasons,
  synthesizeVoiceSummary,
};
