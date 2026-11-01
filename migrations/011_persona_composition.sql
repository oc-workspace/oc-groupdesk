-- Existing published personas and group bindings retain their pinned behavior.
ALTER TABLE personas ADD COLUMN kind text NOT NULL DEFAULT 'base' CHECK(kind IN ('base','feature'));
ALTER TABLE persona_versions ADD COLUMN kind text NOT NULL DEFAULT 'base' CHECK(kind IN ('base','feature'));
ALTER TABLE persona_versions ADD CONSTRAINT persona_version_identity UNIQUE(id,persona_id);
ALTER TABLE groups ADD COLUMN persona_follow_latest boolean NOT NULL DEFAULT false;
CREATE TABLE group_persona_features (
 group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 persona_id uuid NOT NULL REFERENCES personas(id),
 version_id uuid NOT NULL,
 position smallint NOT NULL CHECK(position BETWEEN 0 AND 4),
 follow_latest boolean NOT NULL DEFAULT false,
 PRIMARY KEY(group_id,persona_id), UNIQUE(group_id,position),
 FOREIGN KEY(version_id,persona_id) REFERENCES persona_versions(id,persona_id)
);
