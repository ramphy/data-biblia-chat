const { Client } = require('pg');

// WARNING: Hardcoding credentials is not recommended for production.
// Consider using environment variables.
const dbConfig = {
  host: 'portainer.beta.redmasiva.com',
  user: 'data-biblia-chat',
  database: 'data-biblia-chat',
  password: 'Ramphy123;;', // Ensure this is correct
  port: 5432, // Default PostgreSQL port
};

const TableQuerys = `
-- Drop existing table if it exists to ensure schema update (optional, be careful with existing data)
-- DROP TABLE IF EXISTS audio_biblia;

CREATE TABLE IF NOT EXISTS audio_biblia (
    id SERIAL PRIMARY KEY,
    bible_abbreviation VARCHAR(20) NOT NULL,
    bible_book VARCHAR(10) NOT NULL,
    bible_chapter VARCHAR(10) NOT NULL,
    s3_url TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (bible_abbreviation, bible_book, bible_chapter) -- Ensure combination is unique
);
`;

// WARNING: Database initialized, add changes as updates.
// Changes and Updates start here.


// Changes and Updates end here.

async function setupDatabase() {
  const client = new Client(dbConfig);
  try {
    await client.connect();
    console.log('Connected to the database.');

    await client.query(TableQuerys);
    console.log('Table "audio_biblia" checked/created successfully.');

  } catch (err) {
    console.error('Error setting up database:', err.stack);
  } finally {
    await client.end();
    console.log('Database connection closed.');
  }
}

setupDatabase();
