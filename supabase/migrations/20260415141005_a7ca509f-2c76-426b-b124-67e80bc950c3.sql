
-- 1. Purge all error and done jobs to free up queue slots
DELETE FROM jobs WHERE type = 'SYNC_TO_WOO' AND state IN ('error', 'done');

-- 2. Reset all DRAINING items back to PENDING so they get re-queued
UPDATE pending_product_syncs
SET status = 'PENDING', locked_at = NULL, locked_by = NULL, last_seen_at = now()
WHERE status = 'DRAINING';
