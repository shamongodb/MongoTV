# MongoTV - Native MongoDB Streaming & AI Guide

## Baseline Requirements
- **Auth:** Native MongoDB user collection with bcrypt password hashing.
- **UI:** A SlingTV clone. Dark theme, MongoDB green and black with white text.
- **Browse Page:** Grouped content by genre using MongoDB aggregation `$group` or multiple finds.
- **Detail Page:** Dynamic routing for specific video assets.

## RAG Pipeline (The "MongoTV Guide")
1. **Ingestion:** A script to fetch metadata, call VoyageAI for embeddings, and `upsert` to MongoDB.
2. **Search:** Use `$vectorSearch` stage in a MongoDB aggregation pipeline.
3. **Chat:** A persistent chat widget that provides "Live Guide" assistance.

## Setup
1. Copy `.env.example` to `.env` and set `MONGODB_URI`, `JWT_SECRET`, and `VOYAGE_API_KEY`.
2. Run `npm run ingest` to seed the `Content` collection with sample data and VoyageAI embeddings.
3. **Atlas Vector Search:** In MongoDB Atlas, create a Vector Search index on the `Content` collection named `content_vector_index` with a single vector field mapping: `embedding` (type: vector, dimensions: match your Voyage model, e.g. 1024 for voyage-3).
4. Start the app: `npm start`.