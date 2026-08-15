-- Canonical resolved places (the graph nodes)
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                       -- landmark | building | shop | street | area
  canonical_name TEXT NOT NULL,             -- normalized Arabic
  lat REAL, lng REAL,
  source TEXT NOT NULL,                     -- osm | learned | municipal
  confidence REAL NOT NULL DEFAULT 0.5,
  confirmations INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);

-- Name variants -> entity (the entity-resolution memory)
CREATE TABLE IF NOT EXISTS entity_aliases (
  id INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  alias TEXT NOT NULL,                      -- normalized variant as seen in text
  UNIQUE(entity_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_alias ON entity_aliases(alias);

-- Verified customer addresses (graph edges: text <-> point <-> person)
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY,
  phone_hash TEXT,
  raw_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  lat REAL, lng REAL,
  building_entity_id INTEGER REFERENCES entities(id),
  status TEXT NOT NULL DEFAULT 'unverified', -- unverified | pinned | delivery_verified
  verified_count INTEGER NOT NULL DEFAULT 0,
  contradictions INTEGER NOT NULL DEFAULT 0,
  official_neighborhood TEXT,
  official_parcel TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_addr_phone ON addresses(phone_hash);
CREATE INDEX IF NOT EXISTS idx_addr_bldg ON addresses(building_entity_id);

CREATE TABLE IF NOT EXISTS resolutions (
  id INTEGER PRIMARY KEY,
  raw_text TEXT NOT NULL,
  phone_hash TEXT,
  parsed_json TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'rules',
  tier INTEGER,
  matched_address_id INTEGER REFERENCES addresses(id),
  matched_entity_ids TEXT,                  -- JSON array
  lat REAL, lng REAL,
  confidence REAL,
  status TEXT,
  explain_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  items_json TEXT NOT NULL,
  phone TEXT NOT NULL,
  raw_address TEXT NOT NULL,
  resolution_id INTEGER REFERENCES resolutions(id),
  pin_token TEXT UNIQUE,
  address_id INTEGER REFERENCES addresses(id),
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY,
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  aliases TEXT                              -- JSON array of normalized spellings
);

CREATE TABLE IF NOT EXISTS road_events (
  id INTEGER PRIMARY KEY,
  checkpoint_id INTEGER REFERENCES checkpoints(id),
  status TEXT NOT NULL,                     -- open | congested | closed
  source TEXT NOT NULL,                     -- telegram | whatsapp | driver
  raw_text TEXT,
  reported_at INTEGER NOT NULL              -- epoch ms, UTC. never a local-time string.
);
CREATE INDEX IF NOT EXISTS idx_road_cp ON road_events(checkpoint_id, reported_at);

CREATE TABLE IF NOT EXISTS points_ledger (
  id INTEGER PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,                     -- pin_verified | sparse_bonus | neighbor_assist | road_corroborated
  state TEXT NOT NULL DEFAULT 'pending',    -- pending | verified | revoked
  ref_type TEXT, ref_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
