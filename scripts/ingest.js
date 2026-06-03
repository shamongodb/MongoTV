require('dotenv').config();
const { connect, getDb } = require('../src/db/connection');
const { embedDocuments } = require('../src/services/voyage');

const SAMPLE_CONTENT = [
  { title: 'The Midnight Run', genre: 'Action', description: 'A former cop and a fugitive race across the country in this action comedy.', type: 'movie', year: 1988 },
  { title: 'Inception', genre: 'Sci-Fi', description: 'A thief who steals corporate secrets through dream-sharing technology is offered a chance to have his criminal record erased.', type: 'movie', year: 2010 },
  { title: 'The Shawshank Redemption', genre: 'Drama', description: 'Two imprisoned men bond over a number of years, finding solace and eventual redemption through acts of common decency.', type: 'movie', year: 1994 },
  { title: 'Comedy Hour Live', genre: 'Comedy', description: 'Stand-up special featuring top comedians in a live audience setting.', type: 'special', year: 2023 },
  { title: 'Space Odyssey', genre: 'Sci-Fi', description: 'Humanity discovers a mysterious monolith on the moon and embarks on a journey to Jupiter.', type: 'movie', year: 1968 },
  { title: 'Horror Manor', genre: 'Horror', description: 'A family inherits a manor with a dark secret in the basement.', type: 'movie', year: 2022 },
  { title: 'Romance in Paris', genre: 'Romance', description: 'Two strangers meet in Paris and fall in love over one weekend.', type: 'movie', year: 2019 },
  { title: 'Documentary: Oceans', genre: 'Documentary', description: 'A deep dive into the world\'s oceans and marine life.', type: 'documentary', year: 2021 },
  { title: 'Action Force One', genre: 'Action', description: 'Elite soldiers must stop a terrorist plot in this high-octane thriller.', type: 'movie', year: 2024 },
  { title: 'Laugh Factory', genre: 'Comedy', description: 'The best sketch comedy from the past decade.', type: 'series', year: 2020 },
  { title: 'The Dark Forest', genre: 'Sci-Fi', description: 'Scientists make first contact with an alien civilization in this adaptation of the acclaimed novel.', type: 'series', year: 2023 },
  { title: 'True Crime: The Heist', genre: 'Documentary', description: 'The inside story of the century\'s biggest art heist.', type: 'documentary', year: 2022 },
  { title: 'Heartstrings', genre: 'Romance', description: 'A musician and a doctor navigate love and loss in a small town.', type: 'series', year: 2023 },
  { title: 'Haunted', genre: 'Horror', description: 'Reality series where investigators explore reportedly haunted locations.', type: 'series', year: 2021 },
  { title: 'Drama at Dawn', genre: 'Drama', description: 'A family confronts decades of secrets over one long night.', type: 'movie', year: 2020 },
];

async function ingest() {
  console.log('Connecting to MongoDB...');
  await connect();
  const db = await getDb();
  const collection = db.collection('Content');

  console.log('Generating embeddings with VoyageAI...');
  const textsToEmbed = SAMPLE_CONTENT.map(
    (c) => `${c.title} ${c.genre} ${c.description} ${c.type} ${c.year || ''}`.trim()
  );
  const embeddings = await embedDocuments(textsToEmbed);

  const docs = SAMPLE_CONTENT.map((item, i) => ({
    ...item,
    embedding: embeddings[i] || null,
    updatedAt: new Date(),
  }));

  console.log('Upserting content to Content collection...');
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    await collection.updateOne(
      { title: doc.title, type: doc.type },
      { $set: doc },
      { upsert: true }
    );
  }

  console.log(`Ingest complete. ${docs.length} items in Content.`);
  process.exit(0);
}

ingest().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
