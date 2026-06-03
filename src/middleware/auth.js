const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/connection');

const JWT_SECRET = process.env.JWT_SECRET || 'mongotv-dev-secret-change-in-production';

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = await getDb();
    const user = await db.collection('Users').findOne({ _id: new ObjectId(decoded.userId) });
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = await getDb();
    const user = await db.collection('Users').findOne({ _id: new ObjectId(decoded.userId) });
    if (user) req.user = user;
  } catch (_) {}
  next();
}

module.exports = { requireAuth, optionalAuth, JWT_SECRET };
