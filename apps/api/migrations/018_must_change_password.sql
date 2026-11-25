-- People added by "Import people" with a temporary password must choose their
-- own at first sign-in; until then the server lets them do nothing else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
