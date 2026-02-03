-- 1) Distributori (utenti)
-- Se hai già una tabella users, ADATTA: qui è solo un esempio pulito.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'dealer', -- 'admin' | 'dealer'
  company_name  TEXT,
  logo_url      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Ordini / richieste
CREATE TABLE IF NOT EXISTS orders (
  id               BIGSERIAL PRIMARY KEY,
  dealer_user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'uploaded',
  notes_dealer     TEXT,
  notes_admin      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_dealer ON orders(dealer_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 3) File allegati all’ordine
CREATE TABLE IF NOT EXISTS order_files (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'other',  -- spec | artwork | reference | other
  filename      TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  mime          TEXT,
  size_bytes    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_files_order ON order_files(order_id);

-- 4) Preventivo (1 attivo per ordine, semplice)
CREATE TABLE IF NOT EXISTS quotes (
  id             BIGSERIAL PRIMARY KEY,
  order_id       BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  price_total    NUMERIC(12,2),
  currency       TEXT NOT NULL DEFAULT 'EUR',
  lead_time_days INT,
  pdf_path       TEXT,
  sent_at        TIMESTAMPTZ,
  accepted_at    TIMESTAMPTZ
);

-- 5) Bozze (versionate)
CREATE TABLE IF NOT EXISTS proofs (
  id                 BIGSERIAL PRIMARY KEY,
  order_id           BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  version            INT NOT NULL DEFAULT 1,
  pdf_path_ultrapixel TEXT NOT NULL,
  pdf_path_whitelabel TEXT,
  sent_at            TIMESTAMPTZ,
  approved_at        TIMESTAMPTZ,
  UNIQUE(order_id, version)
);

CREATE INDEX IF NOT EXISTS idx_proofs_order ON proofs(order_id);

-- 6) Audit log (ti salva la vita)
CREATE TABLE IF NOT EXISTS order_events (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,
  payload_json  JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

-- 7) Updated_at auto (semplice, senza trigger: lo gestiamo in query)
