CREATE TABLE deleted_habits (
  habit INTEGER PRIMARY KEY REFERENCES habits(id)
) STRICT;
