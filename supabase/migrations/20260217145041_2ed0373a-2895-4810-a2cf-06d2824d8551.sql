
CREATE OR REPLACE FUNCTION public.validate_no_duplicate_triggers()
RETURNS TABLE (
  violation_type text,
  table_name text,
  trigger_count integer,
  trigger_names text[],
  function_names text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH trigger_sources AS (
    SELECT
      c.relname::text AS tbl,
      t.tgname::text AS trg,
      p.proname::text AS fn,
      pg_catalog.pg_get_functiondef(p.oid) AS src
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_proc p ON t.tgfoid = p.oid
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
  ),
  job_writers AS (
    SELECT tbl, trg, fn FROM trigger_sources WHERE src ILIKE '%INSERT INTO jobs%'
  ),
  pending_writers AS (
    SELECT tbl, trg, fn FROM trigger_sources WHERE src ILIKE '%pending_product_syncs%'
  ),
  job_dupes AS (
    SELECT 'duplicate_job_writer'::text AS vtype, tbl, count(*)::integer AS cnt,
      array_agg(trg ORDER BY trg) AS trgs, array_agg(fn ORDER BY trg) AS fns
    FROM job_writers GROUP BY tbl HAVING count(*) > 1
  ),
  pending_dupes AS (
    SELECT 'duplicate_pending_writer'::text AS vtype, tbl, count(*)::integer AS cnt,
      array_agg(trg ORDER BY trg) AS trgs, array_agg(fn ORDER BY trg) AS fns
    FROM pending_writers GROUP BY tbl HAVING count(*) > 1
  ),
  unsafe AS (
    SELECT 'missing_idempotent_insert'::text AS vtype, tbl, 1::integer AS cnt,
      ARRAY[trg] AS trgs, ARRAY[fn] AS fns
    FROM trigger_sources
    WHERE src ILIKE '%INSERT INTO jobs%'
      AND src NOT ILIKE '%unique_violation%'
      AND src NOT ILIKE '%ON CONFLICT%'
  )
  SELECT * FROM job_dupes
  UNION ALL SELECT * FROM pending_dupes
  UNION ALL SELECT * FROM unsafe;
END;
$$;
