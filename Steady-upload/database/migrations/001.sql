CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE habits (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK(length(description) <= 500),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
  active INTEGER NOT NULL CHECK(active IN (0,1)), position INTEGER NOT NULL CHECK(position >= 0),
  default_key TEXT NOT NULL DEFAULT '' CHECK(default_key IN ('','physical','vietnamese','skill','reflection'))
) STRICT;
CREATE UNIQUE INDEX habits_default_key ON habits(default_key) WHERE default_key<>'';
CREATE TABLE days (day TEXT PRIMARY KEY CHECK(day GLOB '????-??-??')) STRICT;
CREATE TABLE snapshots (
  day TEXT REFERENCES days(day), habit INTEGER REFERENCES habits(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK(length(description) <= 500),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
  position INTEGER NOT NULL CHECK(position >= 0), PRIMARY KEY(day,habit)
) STRICT;
CREATE INDEX snapshots_habit ON snapshots(habit,day);
CREATE TABLE completions (
  day TEXT, habit INTEGER, PRIMARY KEY(day,habit),
  FOREIGN KEY(day,habit) REFERENCES snapshots(day,habit)
) STRICT;
CREATE TABLE moods (
  day TEXT PRIMARY KEY REFERENCES days(day), mood TEXT NOT NULL CHECK(mood IN ('Great','Good','Okay','Difficult'))
) STRICT;
CREATE TABLE journals (
  id TEXT PRIMARY KEY, day TEXT NOT NULL REFERENCES days(day),
  mode TEXT NOT NULL CHECK(mode IN ('guided','free')), ciphertext TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0)
) STRICT;
CREATE INDEX journal_day ON journals(day,created);
CREATE UNIQUE INDEX journal_guided ON journals(day) WHERE mode='guided';
CREATE TABLE challenges (id INTEGER PRIMARY KEY, started TEXT NOT NULL REFERENCES days(day)) STRICT;
CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
CREATE INDEX sessions_expiry ON sessions(expires);

