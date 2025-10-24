import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log('SFTP Watcher: Disabled - using GitHub Actions instead');

  return new Response(
    JSON.stringify({
      message: 'SFTP watcher is disabled. XML files are now processed via GitHub Actions workflow.',
      info: 'See README-GITHUB-ACTIONS.md for setup instructions',
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
