-- 002_good_news_notified.sql
-- Tracks whether good news notifications have been sent to nominator + recipients.
-- NULL = not yet notified; set to NOW() after Tuesday send.
-- Re-approval resets this to NULL so notifications re-queue for the next run.

ALTER TABLE good_news ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ DEFAULT NULL;
