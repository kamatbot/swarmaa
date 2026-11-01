-- An approval question's exact action: {kind, summary, detail, where?}. Null for plain questions.
ALTER TABLE questions ADD COLUMN action jsonb;
