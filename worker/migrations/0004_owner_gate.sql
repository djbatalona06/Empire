-- Two-step sign-in ("owner gate").
-- An email link proves you own the mailbox (trust level 1). A password proves you are the person (level 2).
-- Users with require_password = 1 can only reach the real data with a level-2 session.
-- Everyone else keeps today's one-step sign-in. Safe to run on a database that already has data.

ALTER TABLE users ADD COLUMN require_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- Trust level a refresh token was issued at, so refreshing can never raise it. Old rows are level 2.
ALTER TABLE sessions ADD COLUMN aal INTEGER NOT NULL DEFAULT 2;
