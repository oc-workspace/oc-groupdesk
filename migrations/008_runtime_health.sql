ALTER TABLE groups ADD COLUMN runtime_health jsonb;
ALTER TABLE groups ADD COLUMN runtime_health_at timestamptz;
CREATE TABLE runtime_notifications (
 adapter_token_hash text PRIMARY KEY REFERENCES runtime_adapters(token_hash) ON DELETE CASCADE,
 recipient_wechat_id text NOT NULL,
 key_ciphertext text,
 enabled boolean NOT NULL DEFAULT false,
 binding_confirmed boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1
);
