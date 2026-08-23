-- AgenticWallet marketplace: developers, the agents they publish, and the
-- receipt for every call that was paid for.
--
-- Two rules shape this file.
--
-- Money is INTEGER microALGO everywhere. Never NUMERIC, never a float: ALGO has
-- exactly six decimals, microALGO is the atomic unit the chain moves, and a
-- rounding error in a payments table is money that cannot be reconciled with
-- the chain afterwards. BIGINT because 2^53 microALGO is ~9 billion ALGO, which
-- is more than the total supply, and BIGINT costs nothing.
--
-- A receipt is written only AFTER the chain has confirmed. There is no
-- "pending" row that later turns real — a row in `receipts` means the money
-- moved, and `confirmed_round` is the proof anyone can check independently.

CREATE TABLE IF NOT EXISTS developers (
  id            BIGSERIAL PRIMARY KEY,
  -- The Algorand address earnings are paid to. 58 chars, base32, checksummed.
  -- Validated in the API before it ever reaches here; the CHECK is the backstop
  -- that stops a typo becoming an unrecoverable payout.
  payout_address TEXT NOT NULL CHECK (payout_address ~ '^[A-Z2-7]{58}$'),
  email          TEXT,
  display_name   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One developer per address. Registering the same address twice is an
  -- update, not a second developer, or payouts split across duplicate rows.
  UNIQUE (payout_address)
);

CREATE TABLE IF NOT EXISTS agents (
  -- The slug the extension knows a skill by. NOT a serial: the extension has
  -- already shipped these ids (`p-summary`, `p-table`, …) and the payments
  -- layer keys the payout address on them, so they have to survive a redeploy.
  id             TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  developer_id   BIGINT NOT NULL REFERENCES developers(id) ON DELETE RESTRICT,

  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  -- The prompt/skill body, so the site can show what is actually being sold.
  body           TEXT NOT NULL DEFAULT '',

  price_micro_algo BIGINT NOT NULL CHECK (price_micro_algo > 0),
  network          TEXT   NOT NULL DEFAULT 'testnet'
                          CHECK (network IN ('testnet', 'mainnet', 'localnet')),

  -- An agent is listed only while it is 'live'. Nothing is deleted: a receipt
  -- references the agent, and losing the name would leave a payment nobody can
  -- attribute to anything.
  status         TEXT NOT NULL DEFAULT 'live'
                      CHECK (status IN ('live', 'paused', 'removed')),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agents_developer_idx ON agents (developer_id);
CREATE INDEX IF NOT EXISTS agents_live_idx ON agents (status) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS receipts (
  id              BIGSERIAL PRIMARY KEY,
  agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,

  -- Who paid, and who was paid. Both are recorded on the receipt rather than
  -- looked up through `agents` later: an agent can change its payout address,
  -- and a receipt must keep saying where the money ACTUALLY went.
  buyer_address     TEXT NOT NULL CHECK (buyer_address ~ '^[A-Z2-7]{58}$'),
  developer_address TEXT NOT NULL CHECK (developer_address ~ '^[A-Z2-7]{58}$'),
  company_address   TEXT          CHECK (company_address ~ '^[A-Z2-7]{58}$'),

  -- The split, stored in full. Redundant against total = developer + company on
  -- purpose: recomputing a historical receipt from today's percentage would
  -- silently restate what someone was paid last month.
  total_micro_algo     BIGINT NOT NULL CHECK (total_micro_algo > 0),
  developer_micro_algo BIGINT NOT NULL CHECK (developer_micro_algo >= 0),
  company_micro_algo   BIGINT NOT NULL CHECK (company_micro_algo >= 0),
  company_bps          INTEGER NOT NULL CHECK (company_bps BETWEEN 0 AND 10000),
  network_fee_micro_algo BIGINT NOT NULL DEFAULT 0,

  -- The chain's own record. `group_id` is what makes the two payments atomic —
  -- both landed or neither did — so it is the id a receipt is really about.
  group_id        TEXT,
  developer_txid  TEXT NOT NULL,
  company_txid    TEXT,
  confirmed_round BIGINT NOT NULL,
  network         TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet', 'localnet')),

  -- What the money bought, in the words the user saw. The panel shows this back
  -- to them at the end of a run, so it has to be the tool's label and not an id.
  tool_label      TEXT NOT NULL,
  -- Groups the receipts of one chat/run so the panel can show a run's total.
  session_id      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The chain will not include the same transaction twice, and neither will we.
  -- This is what makes settle() safe to retry after a dropped response.
  UNIQUE (developer_txid),

  -- The receipt has to add up. A row that fails this is worse than no row.
  CONSTRAINT receipt_balances
    CHECK (developer_micro_algo + company_micro_algo = total_micro_algo)
);

CREATE INDEX IF NOT EXISTS receipts_agent_idx   ON receipts (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS receipts_session_idx ON receipts (session_id, created_at);
CREATE INDEX IF NOT EXISTS receipts_buyer_idx   ON receipts (buyer_address, created_at DESC);

-- What a developer is owed and has been paid, without scanning every receipt.
CREATE OR REPLACE VIEW developer_earnings AS
  SELECT
    d.id                              AS developer_id,
    d.payout_address,
    COUNT(r.id)                       AS calls,
    COALESCE(SUM(r.developer_micro_algo), 0) AS earned_micro_algo,
    MAX(r.created_at)                 AS last_paid_at
  FROM developers d
  LEFT JOIN agents   a ON a.developer_id = d.id
  LEFT JOIN receipts r ON r.agent_id = a.id
  GROUP BY d.id, d.payout_address;

-- One row per ACTION paid for inside a run.
--
-- A run is thirty actions and a wallet popup per action is unusable, so a run
-- signs ONCE at the end. But "one signature" must not collapse into "one
-- payment" — the whole point of the receipt is which tool got how much, and a
-- single lump sum with a percentage table beside it is exactly the claim this
-- is meant to replace.
--
-- So the group carries one payment LEG per action plus one company leg, and
-- every leg has its own transaction id on chain. Algorand caps a group at 16,
-- which is why a long run settles in more than one group and this table is
-- keyed on the receipt rather than assuming one.
CREATE TABLE IF NOT EXISTS receipt_items (
  id           BIGSERIAL PRIMARY KEY,
  receipt_id   BIGINT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,

  -- The registered agent this action belongs to (navigate, read_url, click …).
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  -- What the step said in the timeline, so the receipt line matches the step
  -- the user watched rather than naming an internal verb.
  action_label TEXT NOT NULL,
  step_index   INTEGER,

  micro_algo   BIGINT NOT NULL CHECK (micro_algo > 0),
  -- Its own leg, its own transaction. This is the column that makes a receipt
  -- line independently checkable on a public explorer.
  txid         TEXT NOT NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (txid)
);

CREATE INDEX IF NOT EXISTS receipt_items_receipt_idx ON receipt_items (receipt_id, step_index);
CREATE INDEX IF NOT EXISTS receipt_items_agent_idx   ON receipt_items (agent_id, created_at DESC);
