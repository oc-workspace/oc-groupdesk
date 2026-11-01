CREATE TABLE interaction_definitions(
 id uuid PRIMARY KEY,builtin_key text UNIQUE,name text NOT NULL,kind text NOT NULL CHECK(kind IN ('daily_checkin','custom_reply')),
 description text NOT NULL DEFAULT '',instructions text NOT NULL DEFAULT '',commands jsonb NOT NULL,
 archived boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE interaction_settings(
 group_id uuid PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,settings jsonb NOT NULL
);
CREATE TABLE group_interactions(
 id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 definition_id uuid NOT NULL REFERENCES interaction_definitions(id),config jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(group_id,definition_id)
);
CREATE TABLE interaction_wallets(
 group_id uuid NOT NULL REFERENCES groups(id),actor_key text NOT NULL,display_name text NOT NULL,identity_kind text NOT NULL,
 balance integer NOT NULL DEFAULT 0 CHECK(balance BETWEEN 0 AND 1000000000),reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=balance),
 updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(group_id,actor_key)
);
CREATE TABLE interaction_daily_checkins(
 group_id uuid NOT NULL,actor_key text NOT NULL,day_key date NOT NULL,count integer NOT NULL DEFAULT 0,
 PRIMARY KEY(group_id,actor_key,day_key),FOREIGN KEY(group_id,actor_key) REFERENCES interaction_wallets(group_id,actor_key)
);
CREATE TABLE interaction_prizes(
 id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES groups(id),code text NOT NULL,name text NOT NULL,description text NOT NULL DEFAULT '',
 cost integer NOT NULL CHECK(cost BETWEEN 1 AND 1000000000),stock integer CHECK(stock>=0),enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(group_id,code)
);
CREATE TABLE interaction_events(
 id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES groups(id),binding_id uuid NOT NULL REFERENCES group_interactions(id),
 source_id text NOT NULL,request_hash text NOT NULL,adapter_hash text NOT NULL,actor_key text NOT NULL,source_at timestamptz NOT NULL,
 group_revision integer NOT NULL,locale text NOT NULL,outcome text NOT NULL,data jsonb NOT NULL,response text NOT NULL,
 expires_at timestamptz NOT NULL,delivery_status text NOT NULL DEFAULT 'waiting' CHECK(delivery_status IN ('waiting','reserved','sent','uncertain','failed','expired')),
 created_at timestamptz NOT NULL DEFAULT now(),delivered_at timestamptz,UNIQUE(group_id,source_id),
 FOREIGN KEY(group_id,actor_key) REFERENCES interaction_wallets(group_id,actor_key)
);
CREATE TABLE interaction_redemptions(
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE REFERENCES interaction_events(id) DEFERRABLE INITIALLY DEFERRED,
 group_id uuid NOT NULL,actor_key text NOT NULL,prize_id uuid NOT NULL REFERENCES interaction_prizes(id),
 prize_name text NOT NULL,prize_code text NOT NULL,cost integer NOT NULL,stock_reserved boolean NOT NULL DEFAULT false,request_code text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','fulfilled','rejected','cancelled')),
 review_note text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(group_id,actor_key) REFERENCES interaction_wallets(group_id,actor_key)
);
CREATE TABLE interaction_ledger(
 id bigserial PRIMARY KEY,group_id uuid NOT NULL,actor_key text NOT NULL,event_id uuid REFERENCES interaction_events(id) DEFERRABLE INITIALLY DEFERRED,
 redemption_id uuid REFERENCES interaction_redemptions(id),delta integer NOT NULL,reason text NOT NULL,actor text NOT NULL,idempotency_key text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(event_id,reason),FOREIGN KEY(group_id,actor_key) REFERENCES interaction_wallets(group_id,actor_key)
);
CREATE TABLE interaction_daily_usage(
 group_id uuid NOT NULL REFERENCES groups(id),day_key date NOT NULL,replies integer NOT NULL DEFAULT 0,ai_calls integer NOT NULL DEFAULT 0,PRIMARY KEY(group_id,day_key)
);
CREATE TABLE interaction_templates(
 cache_key text PRIMARY KEY,group_id uuid NOT NULL REFERENCES groups(id),binding_id uuid NOT NULL REFERENCES group_interactions(id),
 locale text NOT NULL,outcome text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','ready','failed','cancelled')),
 template text,model_id text,error text,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interaction_events_pending ON interaction_events(group_id,created_at DESC);
CREATE INDEX interaction_wallets_balance ON interaction_wallets(group_id,balance DESC);
CREATE INDEX interaction_redemptions_pending ON interaction_redemptions(group_id,status,created_at DESC);
CREATE INDEX interaction_templates_jobs ON interaction_templates(status,created_at);
