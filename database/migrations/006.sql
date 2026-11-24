CREATE TABLE habit_icons (
  habit INTEGER PRIMARY KEY REFERENCES habits(id),
  icon TEXT NOT NULL CHECK(icon IN ('plus','physical','vietnamese','skill','reflection'))
) STRICT;
