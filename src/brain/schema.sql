-- Augmented Brain schema (v2 §5). Idempotent: every object uses IF NOT EXISTS.
-- All tables live in store/brain.db (separate from store/messages.db).
-- Do NOT add tables here that exist in messages.db (e.g. knowledge_facts,
-- tracked_items). Migration of those lives in P2.

-- -------------------------------------------------------------------------
-- 5.1 Entities
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entities (
  entity_id    TEXT PRIMARY KEY,       -- ULID
  entity_type  TEXT NOT NULL CHECK (entity_type IN
                 ('person','company','project','product','topic')),
  canonical    TEXT,                   -- JSON
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(entity_type);

CREATE TABLE IF NOT EXISTS entity_aliases (
  alias_id     TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL REFERENCES entities(entity_id),
  source_type  TEXT NOT NULL,
  source_ref   TEXT,
  field_name   TEXT NOT NULL,          -- email|domain|phone|name|slack_id
  field_value  TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  valid_until  TEXT,
  confidence   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alias_entity      ON entity_aliases(entity_id);
CREATE INDEX IF NOT EXISTS idx_alias_field_value ON entity_aliases(field_name, field_value);
CREATE INDEX IF NOT EXISTS idx_alias_source      ON entity_aliases(source_type, source_ref);

CREATE TABLE IF NOT EXISTS entity_relationships (
  rel_id          TEXT PRIMARY KEY,    -- ULID
  from_entity_id  TEXT NOT NULL REFERENCES entities(entity_id),
  relationship    TEXT NOT NULL,       -- works_at|reports_to|owns|member_of|mentions
  to_entity_id    TEXT NOT NULL REFERENCES entities(entity_id),
  valid_from      TEXT NOT NULL,
  valid_until     TEXT,
  source_type     TEXT,
  confidence      REAL NOT NULL,
  UNIQUE (from_entity_id, relationship, to_entity_id, valid_from)
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON entity_relationships(from_entity_id, relationship);
CREATE INDEX IF NOT EXISTS idx_rel_to   ON entity_relationships(to_entity_id, relationship);

CREATE TABLE IF NOT EXISTS entity_merge_log (
  merge_id           TEXT PRIMARY KEY,    -- ULID
  kept_entity_id     TEXT NOT NULL,
  merged_entity_id   TEXT NOT NULL,
  pre_merge_snapshot TEXT NOT NULL,       -- JSON
  confidence         REAL NOT NULL,
  evidence           TEXT,                -- JSON
  merged_at          TEXT NOT NULL,
  merged_by          TEXT NOT NULL        -- 'deterministic'|'splink'|'human:<id>'
);

-- -------------------------------------------------------------------------
-- 5.2 Knowledge Units
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_units (
  id                TEXT PRIMARY KEY,  -- ULID
  text              TEXT NOT NULL,
  source_type       TEXT NOT NULL,     -- email|gong|hubspot|browser|manual|attachment|tracked_item
  source_ref        TEXT,
  account           TEXT NOT NULL CHECK (account IN ('personal','work')),
  scope             TEXT,              -- JSON array of tags
  confidence        REAL NOT NULL DEFAULT 1.0,
  valid_from        TEXT NOT NULL,
  valid_until       TEXT,
  recorded_at       TEXT NOT NULL,
  superseded_at     TEXT,
  topic_key         TEXT,
  tags              TEXT,              -- JSON array
  extracted_by      TEXT,
  extraction_chain  TEXT,              -- JSON array of source KU ids
  metadata          TEXT,              -- JSON
  access_count      INTEGER NOT NULL DEFAULT 0,
  last_accessed_at  TEXT,
  needs_review      INTEGER NOT NULL DEFAULT 0,
  important         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ku_account      ON knowledge_units(account, valid_from);
CREATE INDEX IF NOT EXISTS idx_ku_source       ON knowledge_units(source_type, source_ref);
CREATE INDEX IF NOT EXISTS idx_ku_topic        ON knowledge_units(topic_key) WHERE topic_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ku_superseded   ON knowledge_units(superseded_at) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ku_recorded     ON knowledge_units(recorded_at);
CREATE INDEX IF NOT EXISTS idx_ku_needs_review ON knowledge_units(needs_review) WHERE needs_review = 1;
-- idx_ku_important is created in applyColumnMigrations (src/brain/db.ts)
-- because the `important` column is added via ALTER TABLE for pre-existing
-- brain.db files. Declaring the index here would fail on those DBs since
-- schema.sql runs BEFORE the ALTER TABLE.

CREATE TABLE IF NOT EXISTS ku_entities (
  ku_id      TEXT NOT NULL REFERENCES knowledge_units(id),
  entity_id  TEXT NOT NULL REFERENCES entities(entity_id),
  role       TEXT NOT NULL,            -- subject|object|mentioned|author
  PRIMARY KEY (ku_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_ku_entities_entity ON ku_entities(entity_id);

-- -------------------------------------------------------------------------
-- 5.3 Raw events (immutable append-only capture)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS raw_events (
  id            TEXT PRIMARY KEY,      -- ULID
  source_type   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  payload       BLOB NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  process_error TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_type, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_raw_unprocessed ON raw_events(processed_at) WHERE processed_at IS NULL;

-- -------------------------------------------------------------------------
-- 5.4 System state (observability)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_log (
  id          TEXT PRIMARY KEY,
  day         TEXT NOT NULL,           -- YYYY-MM-DD
  provider    TEXT NOT NULL,           -- openai|anthropic|cohere
  operation   TEXT NOT NULL,           -- embed|extract|rerank
  units       INTEGER NOT NULL,
  cost_usd    REAL NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_day ON cost_log(day, provider);

-- -------------------------------------------------------------------------
-- 5.6 Retrieval log — per-query audit of what the agent saw
-- -------------------------------------------------------------------------
-- Each recall() call writes one ku_queries row (the query envelope) plus
-- one ku_retrievals row per KU returned in the final top-N. Purely
-- observational: no back-pressure on retrieval.

CREATE TABLE IF NOT EXISTS ku_queries (
  id            TEXT PRIMARY KEY,      -- ULID
  query_text    TEXT NOT NULL,
  caller        TEXT,                  -- 'agent'|'recall-command'|'miniapp-search'|...
  account       TEXT,                  -- 'personal'|'work'|NULL (no filter)
  scope         TEXT,                  -- scope filter if any
  result_count  INTEGER NOT NULL,
  duration_ms   INTEGER,
  recorded_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ku_queries_recorded ON ku_queries(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_ku_queries_caller   ON ku_queries(caller, recorded_at DESC);

CREATE TABLE IF NOT EXISTS ku_retrievals (
  query_id         TEXT NOT NULL REFERENCES ku_queries(id) ON DELETE CASCADE,
  ku_id            TEXT NOT NULL,
  rank             INTEGER NOT NULL,   -- 0-indexed position in final top-N
  final_score      REAL NOT NULL,
  rank_score       REAL,
  recency_score    REAL,
  access_score     REAL,
  important_score  REAL,
  PRIMARY KEY (query_id, ku_id)
);
CREATE INDEX IF NOT EXISTS idx_ku_retrievals_ku    ON ku_retrievals(ku_id);
CREATE INDEX IF NOT EXISTS idx_ku_retrievals_query ON ku_retrievals(query_id, rank);

-- -------------------------------------------------------------------------
-- 5.5 FTS5 index over knowledge_units.text
-- -------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS ku_fts USING fts5(
  text,
  content=knowledge_units,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Sync triggers — rebuild FTS row whenever knowledge_units changes.
CREATE TRIGGER IF NOT EXISTS ku_fts_ai AFTER INSERT ON knowledge_units BEGIN
  INSERT INTO ku_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS ku_fts_ad AFTER DELETE ON knowledge_units BEGIN
  INSERT INTO ku_fts(ku_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS ku_fts_au AFTER UPDATE ON knowledge_units BEGIN
  INSERT INTO ku_fts(ku_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO ku_fts(rowid, text) VALUES (new.rowid, new.text);
END;
