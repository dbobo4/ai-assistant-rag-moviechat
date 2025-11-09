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

CREATE TABLE IF NOT EXISTS monitoring (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL,
  model text,
  total_tokens integer,
  total_latency_ms integer
);

CREATE INDEX IF NOT EXISTS telemetry_created_at_idx ON monitoring (created_at);
