-- Harden the internal RLS auto-enable event-trigger function.
-- The function remains callable by the database owner for DDL event-trigger execution,
-- but is no longer exposed as an RPC to API-facing Supabase roles.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

-- Index the campaign image foreign key for joins and parent-row deletes.
CREATE INDEX IF NOT EXISTS idx_safety_campaign_images_campaign_id
  ON public.safety_campaign_images (campaign_id);
