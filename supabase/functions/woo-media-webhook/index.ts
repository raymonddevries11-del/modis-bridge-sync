import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wc-webhook-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * WooCommerce Media Webhook Endpoint
 * 
 * Receives callbacks when WooCommerce product images are updated.
 * Updates the image_sync_status table with webhook confirmation.
 * 
 * Webhook topics to configure in WooCommerce:
 *   - Product updated (woocommerce_update_product)
 *   - Or custom Action: woocommerce_update_product
 * 
 * This webhook confirms that images pushed via the WP Media API
 * are actually attached to the correct WooCommerce products.
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return new Response(
        JSON.stringify({ message: 'Media webhook endpoint ready' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const bodyText = await req.text();

    // Verify HMAC signature
    const signature = req.headers.get('x-wc-webhook-signature');
    const webhookSecret = Deno.env.get('WOOCOMMERCE_WEBHOOK_SECRET');

    if (signature && webhookSecret) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw', encoder.encode(webhookSecret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(bodyText));
      const expectedBase64 = btoa(String.fromCharCode(...new Uint8Array(expectedSig)));

      if (signature !== expectedBase64) {
        console.error('Invalid webhook signature');
        return new Response(
          JSON.stringify({ error: 'Invalid signature' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const payload = JSON.parse(bodyText);
    const wooProductId = payload.id;
    const sku = payload.sku || '';
    const images = payload.images || [];

    if (!wooProductId) {
      return new Response(
        JSON.stringify({ message: 'No product ID in payload' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Media webhook: WC #${wooProductId} (SKU: ${sku}), ${images.length} images`);

    // Find the linked PIM product via woo_products
    const { data: wooProduct } = await supabase
      .from('woo_products')
      .select('product_id, tenant_id')
      .eq('woo_id', wooProductId)
      .maybeSingle();

    if (!wooProduct?.product_id) {
      console.log(`No PIM link found for WC #${wooProductId}, skipping`);
      return new Response(
        JSON.stringify({ message: 'Product not linked to PIM' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract WP media IDs from the webhook payload
    const mediaIds = images
      .map((img: any) => img.id)
      .filter((id: number) => id > 0);

    // Update image_sync_status with webhook confirmation
    const { error: upsertError } = await supabase
      .from('image_sync_status')
      .upsert({
        product_id: wooProduct.product_id,
        tenant_id: wooProduct.tenant_id,
        status: mediaIds.length > 0 ? 'confirmed' : 'uploaded',
        image_count: images.length,
        uploaded_count: mediaIds.length,
        woo_media_ids: mediaIds,
        webhook_confirmed_at: new Date().toISOString(),
      }, { onConflict: 'product_id' });

    if (upsertError) {
      console.error('Failed to update image_sync_status:', upsertError);
    } else {
      console.log(`✓ Webhook confirmed ${mediaIds.length} images for product ${wooProduct.product_id}`);
    }

    // Also remove from pending_product_syncs if the images reason is still there
    await supabase
      .from('pending_product_syncs')
      .delete()
      .eq('product_id', wooProduct.product_id)
      .eq('reason', 'images');

    return new Response(
      JSON.stringify({
        success: true,
        product_id: wooProduct.product_id,
        images_confirmed: mediaIds.length,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Media webhook error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
