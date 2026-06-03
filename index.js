require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { connect } = require('./src/db/connection');

const authRoutes = require('./src/routes/auth');
const browseRoutes = require('./src/routes/browse');
const chatRoutes = require('./src/routes/chat');
const searchRoutes = require('./src/routes/search');
const howItWorksRoutes = require('./src/routes/how-it-works');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth', authRoutes);
app.use('/', browseRoutes);
app.use('/', chatRoutes);
app.use('/', searchRoutes);
app.use('/', howItWorksRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

async function start() {
  app.listen(PORT, () => {
    console.log(`MongoTV running at http://localhost:${PORT}`);
  });
  connect().catch((err) => {
    console.error('Initial MongoDB connection failed:', err.message);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
