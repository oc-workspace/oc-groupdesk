CREATE TABLE admins (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE topics (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE, description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '', color text NOT NULL DEFAULT 'violet'
);
CREATE TABLE knowledge_bases (
  id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE groups (
  id uuid PRIMARY KEY, name text NOT NULL,
  external_id text UNIQUE, enabled boolean NOT NULL DEFAULT false,
  language text NOT NULL DEFAULT 'auto', allow_language_override boolean NOT NULL DEFAULT true,
  interaction text NOT NULL DEFAULT 'mention', revision integer NOT NULL DEFAULT 1,
  applied_revision integer NOT NULL DEFAULT 0, bot_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE group_topics (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, topic_id)
);
CREATE TABLE group_knowledge (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kb_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, kb_id)
);
CREATE TABLE documents (
  id uuid PRIMARY KEY, kb_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  title text NOT NULL, filename text, kind text NOT NULL,
  source_text text, status text NOT NULL DEFAULT 'pending',
  error text, chunks integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0, started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chunks (
  id bigserial PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL, content text NOT NULL, UNIQUE(document_id, ordinal)
);
CREATE TABLE memberships (
  id uuid PRIMARY KEY, group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id text NOT NULL, display_name text NOT NULL,
  evidence text NOT NULL, verified_by uuid NOT NULL REFERENCES admins(id),
  verified_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE(group_id, user_id)
);
CREATE TABLE dm_scenes (
  user_id text PRIMARY KEY, group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text,
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX documents_status ON documents(status, created_at);
CREATE INDEX memberships_user ON memberships(user_id);
CREATE INDEX audit_time ON audit_logs(created_at DESC);
