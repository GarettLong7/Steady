CREATE TABLE personal_notes (
  id TEXT PRIMARY KEY, event_day TEXT NOT NULL, ciphertext TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0)
) STRICT;
CREATE INDEX personal_notes_updated ON personal_notes(modified DESC,id);
CREATE INDEX personal_notes_relevant_day ON personal_notes(coalesce(nullif(event_day,''),date(created,'+8 hours')));
DROP TABLE weekly_reflections;

