CREATE TABLE habit_schedules (
  habit INTEGER PRIMARY KEY REFERENCES habits(id), kind TEXT NOT NULL,
  weekdays INTEGER NOT NULL, target INTEGER NOT NULL,
  CHECK ((kind='weekdays' AND weekdays BETWEEN 1 AND 127 AND target=0) OR
         (kind='weekly' AND target BETWEEN 1 AND 7 AND weekdays=0))
) STRICT;
CREATE TABLE daily_plans (
  day TEXT NOT NULL REFERENCES days(day), habit INTEGER NOT NULL REFERENCES habits(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK(length(description) <= 500),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
  position INTEGER NOT NULL CHECK(position >= 0),
  kind TEXT NOT NULL, target INTEGER NOT NULL, scheduled INTEGER NOT NULL,
  CHECK ((kind='daily' AND scheduled=1 AND target=0) OR
         (kind='weekdays' AND scheduled IN (0,1) AND target=0) OR
         (kind='weekly' AND scheduled=0 AND target BETWEEN 1 AND 7)),
  PRIMARY KEY(day,habit)
) STRICT;
CREATE INDEX daily_plans_habit ON daily_plans(habit,day);
INSERT INTO daily_plans SELECT day,habit,name,description,minutes,position,'daily',0,1 FROM snapshots;
CREATE TABLE extra_completions (
  day TEXT NOT NULL, habit INTEGER NOT NULL, PRIMARY KEY(day,habit),
  FOREIGN KEY(day,habit) REFERENCES daily_plans(day,habit)
) STRICT;
CREATE TABLE monthly_reflections (
  month TEXT PRIMARY KEY CHECK(month GLOB '????-??'), ciphertext TEXT NOT NULL,
  created TEXT NOT NULL, modified TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0)
) STRICT;

