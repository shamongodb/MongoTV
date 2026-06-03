const path = require('path');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'mongotv';
const TLS_CERT_KEY_FILE = process.env.MONGODB_TLS_CERT_KEY_FILE;
const SERVER_SELECTION_TIMEOUT_MS = Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000);
const CONNECT_TIMEOUT_MS = Number(process.env.MONGODB_CONNECT_TIMEOUT_MS || 5000);

let client = null;
let db = null;

function getClientOptions() {
  const options = {
    serverSelectionTimeoutMS: Number.isFinite(SERVER_SELECTION_TIMEOUT_MS)
      ? SERVER_SELECTION_TIMEOUT_MS
      : 5000,
    connectTimeoutMS: Number.isFinite(CONNECT_TIMEOUT_MS) ? CONNECT_TIMEOUT_MS : 5000,
  };
  if (TLS_CERT_KEY_FILE) {
    options.tls = true;
    options.tlsCertificateKeyFile = path.isAbsolute(TLS_CERT_KEY_FILE)
      ? TLS_CERT_KEY_FILE
      : path.resolve(process.cwd(), TLS_CERT_KEY_FILE);
  }
  return options;
}

async function connect() {
  if (db) return db;
  client = new MongoClient(MONGODB_URI, getClientOptions());
  await client.connect();
  db = client.db(DB_NAME);
  return db;
}

async function getDb() {
  if (!db) await connect();
  return db;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = {
  connect,
  getDb,
  close,
};
