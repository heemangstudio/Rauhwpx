-- PRIMARY KEY(session_id, seq) already indexes the event log. This copy only
-- added a second B-tree to maintain on every event insert.
DROP INDEX IF EXISTS events_session_seq;

-- Backups and purges read or delete every command of one session.
CREATE INDEX IF NOT EXISTS commands_session ON commands(session_id);

-- Deleting commands checks this foreign key once per deleted row.
CREATE INDEX IF NOT EXISTS session_human_edits_command ON session_human_edits(command_id);
