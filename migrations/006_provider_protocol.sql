ALTER TABLE model_credentials ADD COLUMN client_type text NOT NULL DEFAULT 'openai'
 CHECK(client_type IN ('openai','openai_responses','gemini'));
