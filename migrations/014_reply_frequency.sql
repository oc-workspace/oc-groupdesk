CREATE TABLE workspace_reply_frequency(id integer PRIMARY KEY CHECK(id=1),revision integer NOT NULL DEFAULT 1,policy jsonb NOT NULL);
INSERT INTO workspace_reply_frequency(id,policy) VALUES(1,'{"windows":[{"minutes":5,"max_replies":6},{"minutes":60,"max_replies":36}],"catch_up":{"enabled":true,"within_minutes":10}}');
ALTER TABLE groups ADD COLUMN reply_frequency_applied_revision integer NOT NULL DEFAULT 0;
