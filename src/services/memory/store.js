const { ObjectId } = require('mongodb');
const { embedDocument, embedQuery } = require('../voyage');

const CHAT_SESSIONS_COLLECTION = 'chat_sessions';
const CHAT_MESSAGES_COLLECTION = 'chat_messages';
const USER_MEMORIES_COLLECTION = 'user_memories';
const USER_MEMORY_INDEX = process.env.USER_MEMORY_VECTOR_INDEX || 'user_memory_vector_index';

const SESSION_TTL_HOURS = Number(process.env.CHAT_SESSION_TTL_HOURS || 24);
const MESSAGE_TTL_DAYS = Number(process.env.CHAT_MESSAGE_TTL_DAYS || 30);
const RECENT_TURN_LIMIT = Number(process.env.CHAT_RECENT_TURN_LIMIT || 8);
const SUMMARY_SOURCE_LIMIT = Number(process.env.CHAT_SUMMARY_SOURCE_LIMIT || 24);
const LONG_TERM_MEMORY_LIMIT = Number(process.env.USER_MEMORY_LIMIT || 5);

let indexesEnsured = false;

function normalizeUserId(userId) {
  if (!userId) return null;
  if (userId instanceof ObjectId) return userId;
  if (typeof userId === 'string' && ObjectId.isValid(userId)) return new ObjectId(userId);
  if (typeof userId === 'object' && userId?._id && ObjectId.isValid(userId._id)) {
    return new ObjectId(userId._id);
  }
  return null;
}

function createExpiryDate(hours) {
  return new Date(Date.now() + Math.max(hours, 1) * 60 * 60 * 1000);
}

function createMessageExpiryDate(days) {
  return new Date(Date.now() + Math.max(days, 1) * 24 * 60 * 60 * 1000);
}

function truncateText(text, max = 200) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function toChatRole(role) {
  if (role === 'assistant' || role === 'system') return role;
  return 'user';
}

function normalizeMemoryText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function buildRollingSummary(messages) {
  const condensed = messages
    .slice(-SUMMARY_SOURCE_LIMIT)
    .map((message) => `${message.role}: ${truncateText(message.content, 180)}`)
    .filter(Boolean);
  return truncateText(condensed.join(' | '), 1500);
}

function extractMemoryCandidates(userMessage) {
  const input = String(userMessage || '').trim();
  const lowered = input.toLowerCase();
  if (!input) return [];

  const candidates = [];
  const patternMap = [
    {
      type: 'like',
      regex: /\b(?:i|we)\s+(?:like|love|enjoy)\s+([^.!?]+)/i,
      confidence: 0.8,
    },
    {
      type: 'preference',
      regex: /\b(?:i|we)\s+(?:prefer|want|looking for)\s+([^.!?]+)/i,
      confidence: 0.75,
    },
    {
      type: 'dislike',
      regex: /\b(?:i|we)\s+(?:do not|don't|dislike|hate)\s+([^.!?]+)/i,
      confidence: 0.78,
    },
    {
      type: 'constraint',
      regex: /\b(?:my|our)\s+(?:child|kid|kids)\s+(?:is|are)\s+(\d{1,2})\b/i,
      confidence: 0.95,
      formatter: (value) => `User has a child age ${value}.`,
    },
    {
      type: 'constraint',
      regex: /\bfamily(?:-friendly)?\b/i,
      confidence: 0.72,
      formatter: () => 'User prefers family-friendly content.',
    },
  ];

  for (const pattern of patternMap) {
    const match = lowered.match(pattern.regex);
    if (!match) continue;
    const sourceValue = match[1] || match[0] || '';
    const text = pattern.formatter
      ? pattern.formatter(sourceValue.trim())
      : `User ${pattern.type === 'dislike' ? 'dislikes' : 'prefers'} ${sourceValue.trim()}.`;
    if (!text) continue;
    candidates.push({
      memoryType: pattern.type,
      text: truncateText(text, 280),
      confidence: pattern.confidence,
    });
  }

  return candidates;
}

async function ensureMemoryIndexes(db) {
  if (indexesEnsured) return;

  const sessions = db.collection(CHAT_SESSIONS_COLLECTION);
  const messages = db.collection(CHAT_MESSAGES_COLLECTION);
  const memories = db.collection(USER_MEMORIES_COLLECTION);

  await Promise.all([
    sessions.createIndex({ sessionId: 1 }, { unique: true, name: 'session_id_unique' }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'sessions_ttl' }),
    sessions.createIndex({ userId: 1, lastActivityAt: -1 }, { name: 'sessions_by_user_activity' }),
    messages.createIndex({ sessionId: 1, createdAt: 1 }, { name: 'messages_by_session_time' }),
    messages.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'messages_ttl' }),
    memories.createIndex({ userId: 1, updatedAt: -1 }, { name: 'memories_by_user_updated' }),
    memories.createIndex(
      { userId: 1, memoryType: 1, normalizedText: 1 },
      { unique: true, name: 'memory_dedupe_unique' }
    ),
  ]);

  indexesEnsured = true;
}

async function getOrCreateSession({ db, sessionId, userId }) {
  const normalizedUserId = normalizeUserId(userId);
  const now = new Date();
  const expiresAt = createExpiryDate(SESSION_TTL_HOURS);

  await db.collection(CHAT_SESSIONS_COLLECTION).updateOne(
    { sessionId },
    {
      $setOnInsert: {
        sessionId,
        userId: normalizedUserId,
        startedAt: now,
        status: 'active',
        rollingSummary: '',
      },
      $set: {
        lastActivityAt: now,
        expiresAt,
      },
    },
    { upsert: true }
  );

  const session = await db.collection(CHAT_SESSIONS_COLLECTION).findOne({ sessionId });
  if (!session) return null;

  if (!session.userId && normalizedUserId) {
    await db
      .collection(CHAT_SESSIONS_COLLECTION)
      .updateOne({ sessionId }, { $set: { userId: normalizedUserId, lastActivityAt: now } });
    session.userId = normalizedUserId;
  }

  return session;
}

function canAccessSession(session, userId) {
  if (!session?.userId) return true;
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return false;
  return String(session.userId) === String(normalizedUserId);
}

async function appendMessage({ db, sessionId, userId, role, content, metadata = null }) {
  const now = new Date();
  const messageDoc = {
    sessionId,
    userId: normalizeUserId(userId),
    role: toChatRole(role),
    content: String(content || '').trim(),
    createdAt: now,
    expiresAt: createMessageExpiryDate(MESSAGE_TTL_DAYS),
  };

  if (metadata && typeof metadata === 'object') {
    messageDoc.metadata = metadata;
  }

  await db.collection(CHAT_MESSAGES_COLLECTION).insertOne(messageDoc);
  await db.collection(CHAT_SESSIONS_COLLECTION).updateOne(
    { sessionId },
    {
      $set: {
        lastActivityAt: now,
        expiresAt: createExpiryDate(SESSION_TTL_HOURS),
      },
    }
  );
}

async function getSessionMessages({ db, sessionId, limit = 100 }) {
  const cappedLimit = Math.min(Math.max(limit, 1), 200);
  return db
    .collection(CHAT_MESSAGES_COLLECTION)
    .find({ sessionId }, { projection: { role: 1, content: 1, createdAt: 1, metadata: 1, _id: 0 } })
    .sort({ createdAt: 1 })
    .limit(cappedLimit)
    .toArray();
}

async function getSessionContext({ db, sessionId }) {
  const session = await db.collection(CHAT_SESSIONS_COLLECTION).findOne({ sessionId });
  const totalTurns = await db.collection(CHAT_MESSAGES_COLLECTION).countDocuments({ sessionId });
  const recentMessagesDescending = await db
    .collection(CHAT_MESSAGES_COLLECTION)
    .find(
      { sessionId },
      { projection: { role: 1, content: 1, createdAt: 1, _id: 0 } }
    )
    .sort({ createdAt: -1 })
    .limit(Math.max(RECENT_TURN_LIMIT, 1))
    .toArray();

  const recentMessages = recentMessagesDescending.reverse();
  const olderTurns = Math.max(totalTurns - recentMessages.length, 0);
  let rollingSummary = String(session?.rollingSummary || '').trim();

  if (olderTurns > 0) {
    const summarySourceDescending = await db
      .collection(CHAT_MESSAGES_COLLECTION)
      .find(
        { sessionId },
        { projection: { role: 1, content: 1, _id: 0 } }
      )
      .sort({ createdAt: -1 })
      .skip(recentMessages.length)
      .limit(SUMMARY_SOURCE_LIMIT)
      .toArray();

    const computedSummary = buildRollingSummary(summarySourceDescending.reverse());
    if (computedSummary && computedSummary !== rollingSummary) {
      rollingSummary = computedSummary;
      await db
        .collection(CHAT_SESSIONS_COLLECTION)
        .updateOne({ sessionId }, { $set: { rollingSummary, lastActivityAt: new Date() } });
    }
  }

  return {
    totalTurns,
    olderTurns,
    rollingSummary,
    recentMessages,
  };
}

async function searchUserMemories({ db, userId, queryText, limit = LONG_TERM_MEMORY_LIMIT }) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return [];

  const safeLimit = Math.min(Math.max(limit, 1), 10);
  const collection = db.collection(USER_MEMORIES_COLLECTION);

  try {
    const queryVector = await embedQuery(queryText, {});
    return await collection
      .aggregate([
        {
          $vectorSearch: {
            index: USER_MEMORY_INDEX,
            path: 'embedding',
            queryVector,
            numCandidates: Math.max(safeLimit * 10, 50),
            limit: safeLimit,
            filter: { userId: normalizedUserId },
          },
        },
        {
          $project: {
            _id: 0,
            memoryType: 1,
            text: 1,
            confidence: 1,
            updatedAt: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ])
      .toArray();
  } catch (_) {
    return collection
      .find(
        { userId: normalizedUserId },
        { projection: { _id: 0, memoryType: 1, text: 1, confidence: 1, updatedAt: 1 } }
      )
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .toArray();
  }
}

async function upsertUserMemories({ db, userId, candidates }) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId || !Array.isArray(candidates) || !candidates.length) {
    return { upserted: 0 };
  }

  const now = new Date();
  let upserted = 0;
  const uniqueCandidates = [];
  const seenKeys = new Set();

  for (const candidate of candidates) {
    const normalizedText = normalizeMemoryText(candidate.text);
    if (!normalizedText) continue;
    const key = `${candidate.memoryType || 'preference'}::${normalizedText}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueCandidates.push({
      memoryType: candidate.memoryType || 'preference',
      text: candidate.text,
      normalizedText,
      confidence:
        typeof candidate.confidence === 'number'
          ? Math.min(Math.max(candidate.confidence, 0), 1)
          : 0.65,
    });
  }

  for (const candidate of uniqueCandidates) {
    let embedding = null;
    try {
      embedding = await embedDocument(candidate.text);
    } catch (_) {
      embedding = null;
    }

    await db.collection(USER_MEMORIES_COLLECTION).updateOne(
      {
        userId: normalizedUserId,
        memoryType: candidate.memoryType,
        normalizedText: candidate.normalizedText,
      },
      {
        $set: {
          text: candidate.text,
          confidence: candidate.confidence,
          updatedAt: now,
          ...(Array.isArray(embedding) ? { embedding } : {}),
        },
        $setOnInsert: {
          userId: normalizedUserId,
          createdAt: now,
          memoryType: candidate.memoryType,
          normalizedText: candidate.normalizedText,
        },
      },
      { upsert: true }
    );
    upserted += 1;
  }

  return { upserted };
}

async function extractAndStoreLongTermMemories({ db, userId, userMessage }) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return { upserted: 0, skipped: true };
  }

  const candidates = extractMemoryCandidates(userMessage);
  if (!candidates.length) {
    return { upserted: 0, skipped: false };
  }

  return upsertUserMemories({ db, userId: normalizedUserId, candidates });
}

module.exports = {
  ensureMemoryIndexes,
  getOrCreateSession,
  canAccessSession,
  appendMessage,
  getSessionMessages,
  getSessionContext,
  searchUserMemories,
  extractAndStoreLongTermMemories,
};
