const express = require('express');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/connection');
const { runRagChat } = require('../services/rag/pipeline');
const { retrieveMovies } = require('../services/rag/retriever');
const { getRagConfig } = require('../services/rag/config');
const { optionalAuth } = require('../middleware/auth');
const {
  ensureMemoryIndexes,
  getOrCreateSession,
  canAccessSession,
  appendMessage,
  getSessionMessages,
  getSessionContext,
  searchUserMemories,
  extractAndStoreLongTermMemories,
} = require('../services/memory/store');

const router = express.Router();

const NUM_RESULTS = 5;
const MAX_TRANSCRIBE_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TTS_INPUT_CHARS = 15000;
const SESSION_ID_REGEX = /^[a-zA-Z0-9._-]{8,80}$/;
const REASON_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'show', 'something', 'that', 'the',
  'their', 'them', 'this', 'to', 'us', 'want', 'watch', 'we', 'with', 'you', 'your'
]);

function sanitizeSessionId(rawSessionId) {
  const value = String(rawSessionId || '').trim();
  if (!value) return null;
  return SESSION_ID_REGEX.test(value) ? value : null;
}

function pickSessionId(req) {
  const shouldStartFreshSession = String(req.query.new || '').toLowerCase() === '1';
  const requestedSessionId = sanitizeSessionId(req.query.sessionId);
  return shouldStartFreshSession ? randomUUID() : requestedSessionId || randomUUID();
}

function toSafeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function tokenizeQuery(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 2 && !REASON_STOP_WORDS.has(token));
}

function isCannedReason(reason) {
  const text = String(reason || '').trim().toLowerCase();
  if (!text) return true;
  return (
    text.startsWith('fits your request') ||
    text.startsWith('picked for your') ||
    text.startsWith('chosen for your') ||
    text.startsWith('chosen to match') ||
    text.startsWith('selected to match')
  );
}

function buildStoryPitch(item) {
  const description = toSafeText(item?.description || item?.plot);
  if (!description) return '';
  return description.slice(0, 170) + (description.length > 170 ? '...' : '');
}

function buildRecommendationReason(query, item) {
  const title = toSafeText(item?.title, 'This title');
  const genre = toSafeText(item?.genre);
  const queryTokens = tokenizeQuery(query).slice(0, 2).join(' ');
  const firstLine = genre && queryTokens
    ? `${title} matches your ${queryTokens} mood with a strong ${genre.toLowerCase()} vibe.`
    : genre
      ? `${title} is a smart pick if you want a ${genre.toLowerCase()} watch right now.`
      : `${title} lines up well with what you asked for in this chat.`;
  const storyHook = buildStoryPitch(item);
  const secondLine = storyHook || `${title} has a memorable story hook that makes it easy to get pulled in.`;
  return `${firstLine}\n${secondLine}`;
}

function toRecommendationItem(item, query = '') {
  if (!item || typeof item !== 'object') return null;
  const id = item._id ? String(item._id) : null;
  if (!id) return null;
  const providedReason = toSafeText(item.reason);
  return {
    _id: id,
    title: toSafeText(item.title, 'Untitled'),
    year: typeof item.year === 'number' ? item.year : null,
    type: toSafeText(item.type, ''),
    genre: toSafeText(item.genre, ''),
    poster: toSafeText(item.poster, ''),
    description: toSafeText(item.description || item.plot, ''),
    score: typeof item.score === 'number' ? Number(item.score.toFixed(5)) : null,
    reason: providedReason,
  };
}

function dedupeRecommendationItems(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items || []) {
    const id = item?._id ? String(item._id).trim() : '';
    const normalizedTitle = toSafeText(item?.title).toLowerCase();
    const normalizedYear = item?.year ? String(item.year).trim() : '';
    const normalizedType = toSafeText(item?.type).toLowerCase();
    // Prefer immutable ids; fall back to semantic keys when duplicate docs exist.
    const dedupeKey = id || `${normalizedTitle}|${normalizedYear}|${normalizedType}`;
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(item);
  }
  return unique;
}

function buildRecommendationRow(query, results) {
  if (!Array.isArray(results) || !results.length) return null;
  const items = dedupeRecommendationItems(
    results.map((item) => toRecommendationItem(item, query)).filter(Boolean)
  );
  if (!items.length) return null;
  return {
    query: toSafeText(query),
    createdAt: new Date().toISOString(),
    items,
  };
}

function buildAssistantMetadata(baseMetadata, query, results) {
  const metadata = baseMetadata && typeof baseMetadata === 'object' ? { ...baseMetadata } : {};
  const recommendationRow = buildRecommendationRow(query, results);
  if (recommendationRow) {
    metadata.recommendationRow = recommendationRow;
  }
  return Object.keys(metadata).length ? metadata : null;
}

function extractRecommendationRows(messages) {
  if (!Array.isArray(messages)) return [];
  let order = 0;
  const rows = messages
    .filter((item) => item?.role === 'assistant' && item?.metadata?.recommendationRow?.items?.length)
    .map((item) => {
      order += 1;
      const row = item.metadata.recommendationRow;
      return {
        order,
        title: row.query ? `Based on: ${row.query}` : `Recommendation Row ${order}`,
        createdAt: row.createdAt || item.createdAt || null,
        items: dedupeRecommendationItems(
          (Array.isArray(row.items) ? row.items : []).map((entry) => ({
            ...entry,
            reason: toSafeText(entry?.reason),
          }))
        ),
      };
    })
    .filter((row) => row.items.length > 0);
  return rows.reverse();
}

router.use(optionalAuth);

router.get('/chat', (req, res) => {
  const sessionId = sanitizeSessionId(req.query.sessionId);
  const shouldStartFreshSession = String(req.query.new || '').toLowerCase() === '1';
  if (shouldStartFreshSession) {
    return res.redirect('/chat/recommendations?new=1');
  }
  if (sessionId) {
    return res.redirect(`/chat/recommendations?sessionId=${encodeURIComponent(sessionId)}`);
  }
  return res.redirect('/chat/recommendations');
});

router.get('/chat/recommendations', async (req, res) => {
  try {
    const sessionId = pickSessionId(req);
    const db = await getDb();
    await ensureMemoryIndexes(db);
    const session = await getOrCreateSession({
      db,
      sessionId,
      userId: req.user?._id || null,
    });
    if (!canAccessSession(session, req.user?._id || null)) {
      return res.status(403).render('error', { message: 'You do not have access to this chat session.' });
    }
    const messages = await getSessionMessages({ db, sessionId, limit: 200 });
    const recommendationRows = extractRecommendationRows(messages);
    return res.render('chat-recommendations', {
      title: 'MongoTV Recommendations',
      activePage: 'chat',
      sessionId,
      recommendationRows,
    });
  } catch (err) {
    console.error('Recommendations page error:', err);
    return res.status(500).render('error', { message: 'Failed to load recommendations.' });
  }
});

router.get('/chat/history', async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.query.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: 'Valid sessionId is required' });
    }

    const db = await getDb();
    await ensureMemoryIndexes(db);

    const session = await getOrCreateSession({
      db,
      sessionId,
      userId: req.user?._id || null,
    });

    if (!canAccessSession(session, req.user?._id || null)) {
      return res.status(403).json({ error: 'You do not have access to this chat session.' });
    }

    const messages = await getSessionMessages({ db, sessionId, limit: 120 });
    return res.json({ sessionId, messages });
  } catch (err) {
    console.error('Chat history error:', err);
    return res.status(500).json({ error: 'Could not load chat history.' });
  }
});

router.post(
  '/chat/transcribe',
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    try {
      const audioBuffer = Buffer.isBuffer(req.body) ? req.body : null;
      if (!audioBuffer || audioBuffer.length === 0) {
        return res.status(400).json({ error: 'Audio payload is required.' });
      }
      if (audioBuffer.length > MAX_TRANSCRIBE_PAYLOAD_BYTES) {
        return res.status(413).json({ error: 'Audio payload is too large.' });
      }

      const ragConfig = getRagConfig();
      if (!ragConfig.xaiApiKey) {
        return res.status(503).json({ error: 'Grok STT is not configured. Set GROK_API_KEY.' });
      }

      const mimeType = String(req.headers['content-type'] || 'audio/webm').split(';')[0].trim() || 'audio/webm';
      const form = new FormData();
      form.append('model', 'grok-stt');
      form.append('language', 'en');
      form.append('format', 'json');
      form.append('file', new Blob([audioBuffer], { type: mimeType }), 'recording.webm');

      const sttResponse = await fetch(`${ragConfig.xaiBaseUrl}/stt`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ragConfig.xaiApiKey}`,
        },
        body: form,
      });

      const responseBody = await sttResponse.json().catch(() => ({}));
      if (!sttResponse.ok) {
        return res.status(502).json({
          error: 'Transcription failed.',
          detail: responseBody?.error || responseBody?.message || null,
        });
      }

      const transcript = String(responseBody?.text || responseBody?.transcript || '').trim();
      if (!transcript) {
        return res.status(422).json({ error: 'Transcription succeeded but no text was returned.' });
      }

      return res.json({ text: transcript });
    } catch (err) {
      console.error('Transcription error:', err);
      return res.status(500).json({ error: 'Could not transcribe audio.' });
    }
  }
);

router.post('/chat/tts', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Text is required.' });
    }
    if (text.length > MAX_TTS_INPUT_CHARS) {
      return res.status(413).json({ error: `Text is too long. Maximum ${MAX_TTS_INPUT_CHARS} characters.` });
    }

    const ragConfig = getRagConfig();
    if (!ragConfig.xaiApiKey) {
      return res.status(503).json({ error: 'Grok TTS is not configured. Set GROK_API_KEY.' });
    }

    const ttsResponse = await fetch(`${ragConfig.xaiBaseUrl}/tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ragConfig.xaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice_id: 'eve',
        language: 'en',
      }),
    });

    if (!ttsResponse.ok) {
      const responseBody = await ttsResponse.json().catch(() => ({}));
      return res.status(502).json({
        error: 'Text-to-speech failed.',
        detail: responseBody?.error || responseBody?.message || null,
      });
    }

    const audioArrayBuffer = await ttsResponse.arrayBuffer();
    const audioBuffer = Buffer.from(audioArrayBuffer);
    res.setHeader('Content-Type', ttsResponse.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err);
    return res.status(500).json({ error: 'Could not synthesize audio.' });
  }
});

router.post('/chat', async (req, res) => {
  try {
    const { message, sessionId: requestSessionId, voiceMode: requestVoiceMode } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }
    const sessionId = sanitizeSessionId(requestSessionId) || randomUUID();
    const voiceMode = requestVoiceMode === true || requestVoiceMode === 'true';

    const db = await getDb();
    await ensureMemoryIndexes(db);
    const trimmedMessage = message.trim();
    const userId = req.user?._id || null;

    const session = await getOrCreateSession({ db, sessionId, userId });
    if (!canAccessSession(session, userId)) {
      return res.status(403).json({ error: 'You do not have access to this chat session.' });
    }

    await appendMessage({
      db,
      sessionId,
      userId,
      role: 'user',
      content: trimmedMessage,
    });

    const sessionContext = await getSessionContext({ db, sessionId });
    const longTermMemories = userId
      ? await searchUserMemories({
          db,
          userId,
          queryText: trimmedMessage,
        })
      : [];

    try {
      const ragResult = await runRagChat({
        db,
        message: trimmedMessage,
        memoryContext: {
          recentMessages: sessionContext.recentMessages,
          rollingSummary: sessionContext.rollingSummary,
          longTermMemories,
        },
        voiceMode,
      });
      if (ragResult?.meta) {
        console.log('RAG chat decision:', ragResult.meta);
      }
      const recommendationRow = buildRecommendationRow(trimmedMessage, ragResult.results);
      const assistantMetadata = buildAssistantMetadata(
        ragResult.meta,
        trimmedMessage,
        recommendationRow?.items || ragResult.results
      );
      await appendMessage({
        db,
        sessionId,
        userId,
        role: 'assistant',
        content: ragResult.response,
        metadata: assistantMetadata,
      });

      if (userId) {
        extractAndStoreLongTermMemories({
          db,
          userId,
          userMessage: trimmedMessage,
        }).catch((err) => {
          console.error('Long-term memory update failed:', err?.message || err);
        });
      }

      return res.json({
        response: ragResult.response,
        voiceSummary: ragResult.voiceSummary || '',
        results: recommendationRow?.items || [],
        sessionId,
      });
    } catch (ragErr) {
      const status = ragErr?.status || ragErr?.response?.status;
      const body =
        ragErr?.response?.data ||
        ragErr?.error ||
        ragErr?.cause?.message ||
        null;
      console.error('RAG pipeline failed, falling back to deterministic chat:', {
        message: ragErr?.message,
        status,
        body,
        name: ragErr?.name,
      });
      const results = await retrieveMovies(db, { queryText: trimmedMessage, topK: NUM_RESULTS });
      const responseText = buildConversationalResponse(trimmedMessage, results);
      const recommendationRow = buildRecommendationRow(trimmedMessage, results);
      const assistantMetadata = buildAssistantMetadata(
        { mode: 'fallback_deterministic' },
        trimmedMessage,
        recommendationRow?.items || results
      );

      await appendMessage({
        db,
        sessionId,
        userId,
        role: 'assistant',
        content: responseText,
        metadata: assistantMetadata,
      });

      if (userId) {
        extractAndStoreLongTermMemories({
          db,
          userId,
          userMessage: trimmedMessage,
        }).catch((err) => {
          console.error('Long-term memory update failed:', err?.message || err);
        });
      }

      return res.json({
        response: responseText,
        voiceSummary: '',
        results: recommendationRow?.items || [],
        sessionId,
      });
    }
  } catch (err) {
    console.error('Chat error:', err);
    if (err.message?.includes('VOYAGE_API_KEY')) {
      return res.status(503).json({ error: 'AI guide is not configured. Set VOYAGE_API_KEY.' });
    }
    if (err.message?.includes('vector search') || err.code === 287) {
      return res.status(503).json({
        error: 'Vector search is not available. Create an Atlas Search vector index on embedded_movies.plot_embedding_voyage_3_large.',
      });
    }
    const payload = { error: 'Something went wrong. Try again.' };
    if (process.env.NODE_ENV !== 'production' && err?.message) {
      payload.detail = err.message;
    }
    res.status(500).json(payload);
  }
});

function buildConversationalResponse(query, results) {
  if (!results.length) {
    return `I couldn't find any content matching "${query}". Try asking about genres like Action, Comedy, Sci-Fi, or specific titles.`;
  }
  const list = results
    .map((r, i) => {
      const why = toSafeText(r.reason || r.description || r.plot, 'No explanation available yet.');
      return `${i + 1}. **${r.title}** (${r.genre || 'N/A'})${r.year ? ` — ${r.year}` : ''}\n${why}`;
    })
    .join('\n');
  return `Here are recommendations based on "${query}":\n\n${list}\n\nWant me to narrow this to one must-watch pick?`;
}

module.exports = router;
