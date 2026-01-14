import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { productIds, tenantId } = await req.json();

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "productIds array is required" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!tenantId) {
      return new Response(
        JSON.stringify({ error: "tenantId is required" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Generating AI content for ${productIds.length} products`);

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[],
    };

    // Process products in batches of 5 to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < productIds.length; i += batchSize) {
      const batch = productIds.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (productId: string) => {
        try {
          // Fetch product data with all related info
          const { data: product, error: productError } = await supabase
            .from("products")
            .select(`
              *,
              brands(name),
              suppliers(name),
              product_prices(regular, list),
              variants(size_label, stock_totals(qty))
            `)
            .eq("id", productId)
            .single();

          if (productError) {
            console.error(`Error fetching product ${productId}:`, productError);
            results.errors.push(`Product ${productId}: ${productError.message}`);
            results.failed++;
            return;
          }

          // Build context for AI
          const productContext = buildProductContext(product);
          
          // Generate AI content using tool calling for structured output
          const aiContent = await generateContent(LOVABLE_API_KEY, productContext);
          
          if (!aiContent) {
            results.errors.push(`Product ${productId}: No AI content generated`);
            results.failed++;
            return;
          }

          // Upsert AI content to database
          const { error: upsertError } = await supabase
            .from("product_ai_content")
            .upsert({
              product_id: productId,
              tenant_id: tenantId,
              ai_title: aiContent.title,
              ai_short_description: aiContent.short_description,
              ai_long_description: aiContent.long_description,
              ai_meta_title: aiContent.meta_title,
              ai_meta_description: aiContent.meta_description,
              ai_keywords: aiContent.keywords,
              ai_features: aiContent.features || [],
              ai_suggested_categories: aiContent.suggested_categories || [],
              status: 'generated',
              generated_at: new Date().toISOString(),
            }, { onConflict: 'product_id' });

          if (upsertError) {
            console.error(`Error saving AI content for ${productId}:`, upsertError);
            results.errors.push(`Product ${productId}: ${upsertError.message}`);
            results.failed++;
            return;
          }

          console.log(`Successfully generated AI content for product ${productId}`);
          results.success++;
        } catch (error) {
          console.error(`Error processing product ${productId}:`, error);
          results.errors.push(`Product ${productId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          results.failed++;
        }
      }));

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < productIds.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`AI content generation complete: ${results.success} success, ${results.failed} failed`);

    return new Response(
      JSON.stringify({
        message: `Generated AI content for ${results.success} products`,
        ...results
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in generate-ai-content:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function buildProductContext(product: any): string {
  const brand = product.brands?.name || 'Onbekend merk';
  const price = product.product_prices?.regular || 'Prijs onbekend';
  const listPrice = product.product_prices?.list;
  const color = product.color?.label || product.color?.filter || '';
  const categories = product.categories?.map((c: any) => c.name).join(', ') || '';
  
  // Extract attributes
  const attributes: string[] = [];
  if (product.attributes) {
    Object.entries(product.attributes).forEach(([key, value]) => {
      if (value) attributes.push(`${key}: ${value}`);
    });
  }
  
  // Get available sizes
  const sizes = product.variants
    ?.filter((v: any) => v.stock_totals?.qty > 0)
    ?.map((v: any) => v.size_label)
    ?.join(', ') || '';

  return `
Product informatie:
- Titel: ${product.title || 'Geen titel'}
- SKU: ${product.sku || 'Geen SKU'}
- Merk: ${brand}
- Prijs: €${price}${listPrice ? ` (adviesprijs: €${listPrice})` : ''}
- Kleur: ${color || 'Niet gespecificeerd'}
- Categorieën: ${categories || 'Geen categorieën'}
- Beschikbare maten: ${sizes || 'Niet gespecificeerd'}
- Eigenschappen: ${attributes.length > 0 ? attributes.join(', ') : 'Geen eigenschappen'}
- Bestaande beschrijving: ${product.webshop_text || product.internal_description || 'Geen beschrijving beschikbaar'}
- Interne omschrijving: ${product.internal_description || 'Niet beschikbaar'}
`.trim();
}

async function generateContent(apiKey: string, productContext: string): Promise<any> {
  const systemPrompt = `Je bent een expert e-commerce copywriter voor een Nederlandse schoenenwinkel. 
Je schrijft overtuigende, SEO-geoptimaliseerde productbeschrijvingen in het Nederlands.
Je bent direct, professioneel en kent de doelgroep (modebewuste Nederlanders).
Gebruik geen overdreven superlatieven of lege marketingfrasen.
Focus op de praktische voordelen en unieke eigenschappen van het product.`;

  const userPrompt = `Genereer geoptimaliseerde content voor het volgende product:

${productContext}

Genereer:
1. Een pakkende producttitel (max 70 karakters)
2. Een korte productomschrijving (50-100 woorden) - focus op de belangrijkste kenmerken
3. Een uitgebreide productomschrijving (150-300 woorden) - SEO-geoptimaliseerd met natuurlijke zoekwoorden
4. Een SEO meta titel (max 60 karakters)
5. Een SEO meta description (max 155 karakters)
6. Relevante zoekwoorden (5-10 keywords, kommagescheiden)
7. 3-5 product features/USPs als korte bullets
8. 2-3 voorgestelde categorieën voor de webshop`;

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "save_product_content",
            description: "Save the generated product content",
            parameters: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Geoptimaliseerde producttitel (max 70 karakters)"
                },
                short_description: {
                  type: "string",
                  description: "Korte productomschrijving (50-100 woorden)"
                },
                long_description: {
                  type: "string",
                  description: "Uitgebreide productomschrijving (150-300 woorden)"
                },
                meta_title: {
                  type: "string",
                  description: "SEO meta titel (max 60 karakters)"
                },
                meta_description: {
                  type: "string",
                  description: "SEO meta description (max 155 karakters)"
                },
                keywords: {
                  type: "string",
                  description: "Relevante zoekwoorden, kommagescheiden"
                },
                features: {
                  type: "array",
                  items: { type: "string" },
                  description: "3-5 product features/USPs"
                },
                suggested_categories: {
                  type: "array",
                  items: { type: "string" },
                  description: "2-3 voorgestelde categorieën"
                }
              },
              required: ["title", "short_description", "long_description", "meta_title", "meta_description", "keywords", "features", "suggested_categories"],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: { type: "function", function: { name: "save_product_content" } }
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("AI gateway error:", response.status, errorText);
    
    if (response.status === 429) {
      throw new Error("Rate limit exceeded, please try again later");
    }
    if (response.status === 402) {
      throw new Error("Payment required, please add credits");
    }
    throw new Error(`AI gateway error: ${response.status}`);
  }

  const data = await response.json();
  
  // Extract tool call arguments
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      return JSON.parse(toolCall.function.arguments);
    } catch (e) {
      console.error("Error parsing tool call arguments:", e);
      throw new Error("Failed to parse AI response");
    }
  }

  throw new Error("No valid tool call in AI response");
}
