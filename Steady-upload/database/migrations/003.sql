CREATE TABLE weekly_reflections (
  week TEXT PRIMARY KEY CHECK(week GLOB '????-??-??'),
  ciphertext TEXT NOT NULL, created TEXT NOT NULL, modified TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0)
) STRICT;

