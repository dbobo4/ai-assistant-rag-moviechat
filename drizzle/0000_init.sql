CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS resources (
  id serial PRIMARY KEY,
  content text NOT NULL,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS embeddings (
  id serial PRIMARY KEY,
  resource_id integer NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL
);
