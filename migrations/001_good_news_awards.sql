-- Migration: Multi-recipient Good News awards
-- Run this in Supabase SQL editor (Dashboard → SQL Editor)
--
-- What this does:
--   1. Creates good_news_awards — one row per recipient per approved nomination
--   2. Leaves good_news unchanged (nominee_name/nominee_dept/pts_nominee kept as
--      the original suggestion; awards table is the source of truth for pts)

CREATE TABLE IF NOT EXISTS good_news_awards (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  good_news_id    bigint NOT NULL REFERENCES good_news(id) ON DELETE CASCADE,
  recipient_name  text   NOT NULL,
  recipient_dept  text,
  pts             integer NOT NULL DEFAULT 3,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gna_good_news_id ON good_news_awards(good_news_id);

-- Optional: back-fill existing approved nominations so their pts still flow
-- through the new table (run only if you have approved rows already).
-- Uncomment and run manually after the table is created.
--
-- INSERT INTO good_news_awards (good_news_id, recipient_name, recipient_dept, pts)
-- SELECT id, nominee_name, nominee_dept, COALESCE(pts_nominee, 3)
-- FROM   good_news
-- WHERE  status = 'Approved'
--   AND  nominee_name IS NOT NULL
--   AND  id NOT IN (SELECT DISTINCT good_news_id FROM good_news_awards);
