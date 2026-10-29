ALTER TABLE bots ADD COLUMN color text
  CHECK (color IN ('blue', 'butter', 'peach', 'lilac', 'pink', 'lime', 'sky', 'orchid'));
