import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { TenantSelector } from "@/components/TenantSelector";
import { Rss, Copy, ExternalLink, Plus, Pencil, Trash2, AlertCircle, CheckCircle2, Loader2, CheckSquare } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { GoogleCategorySearch } from "@/components/GoogleCategorySearch";

interface ShippingRule {
  country: string;
  price: number;
}

interface FeedConfig {
  tenant_id: string;
  shop_url: string;
  feed_title: string;
  feed_description: string;
  currency: string;
  shipping_country: string;
  shipping_price: number;
  shipping_rules: ShippingRule[];
  enabled: boolean;
}

interface CategoryMapping {
  id: string;
  tenant_id: string;
  article_group_id: string;
  article_group_description: string | null;
  google_category: string;
  gender: string;
  age_group: string;
  condition: string;
  material: string | null;
}

const GENDER_OPTIONS = ['male', 'female', 'unisex'];
const AGE_GROUP_OPTIONS = ['adult', 'kids', 'toddler', 'infant', 'newborn'];
const CONDITION_OPTIONS = ['new', 'refurbished', 'used'];

const GoogleFeed = () => {
  const [tenantId, setTenantId] = useState<string>("");
  const [feedConfig, setFeedConfig] = useState<FeedConfig | null>(null);
  const [mappings, setMappings] = useState<CategoryMapping[]>([]);
  const [articleGroups, setArticleGroups] = useState<{ id: string; description: string; productCount: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editMapping, setEditMapping] = useState<Partial<CategoryMapping> | null>(null);
  const [feedStats, setFeedStats] = useState<{ total: number; mapped: number; unmapped: number } | null>(null);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkSelectedGroups, setBulkSelectedGroups] = useState<Set<string>>(new Set());
  const [bulkMapping, setBulkMapping] = useState<{ google_category: string; gender: string; age_group: string; condition: string; material: string }>({
    google_category: '', gender: 'unisex', age_group: 'adult', condition: 'new', material: '',
  });
  const { toast } = useToast();

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const feedUrl = tenantId ? `${supabaseUrl}/functions/v1/google-merchant-feed?tenantId=${tenantId}` : '';

  useEffect(() => {
    if (tenantId) {
      loadData();
    }
  }, [tenantId]);

  const loadData = async () => {
    setLoading(true);
    try {
      await Promise.all([loadFeedConfig(), loadMappings(), loadArticleGroups()]);
    } finally {
      setLoading(false);
    }
  };

  const loadFeedConfig = async () => {
    const { data } = await supabase
      .from('google_feed_config')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    setFeedConfig(data ? { ...data, shipping_rules: (Array.isArray(data.shipping_rules) ? data.shipping_rules : []) } as unknown as FeedConfig : null);
  };

  const loadMappings = async () => {
    const { data } = await supabase
      .from('google_category_mappings')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('article_group_description');
    setMappings((data as CategoryMapping[]) || []);
  };

  const loadArticleGroups = async () => {
    // Fetch distinct article groups from products
    const { data: products } = await supabase
      .from('products')
      .select('article_group')
      .eq('tenant_id', tenantId)
      .not('article_group', 'is', null);

    if (!products) return;

    const groupMap = new Map<string, { id: string; description: string; count: number }>();
    for (const p of products) {
      const ag = p.article_group as any;
      if (ag?.id && ag.id !== '') {
        const existing = groupMap.get(ag.id);
        if (existing) {
          existing.count++;
        } else {
          groupMap.set(ag.id, { id: ag.id, description: ag.description || ag.id, count: 1 });
        }
      }
    }

    const groups = Array.from(groupMap.values())
      .map(g => ({ id: g.id, description: g.description, productCount: g.count }))
      .sort((a, b) => a.description.localeCompare(b.description));
    
    setArticleGroups(groups);

    // Calculate stats
    const mappedIds = new Set(mappings.map(m => m.article_group_id));
    const mapped = groups.filter(g => mappedIds.has(g.id)).reduce((sum, g) => sum + g.productCount, 0);
    const total = groups.reduce((sum, g) => sum + g.productCount, 0);
    setFeedStats({ total, mapped, unmapped: total - mapped });
  };

  // Recalculate stats when mappings change
  useEffect(() => {
    if (articleGroups.length > 0) {
      const mappedIds = new Set(mappings.map(m => m.article_group_id));
      const mapped = articleGroups.filter(g => mappedIds.has(g.id)).reduce((sum, g) => sum + g.productCount, 0);
      const total = articleGroups.reduce((sum, g) => sum + g.productCount, 0);
      setFeedStats({ total, mapped, unmapped: total - mapped });
    }
  }, [mappings, articleGroups]);

  const saveFeedConfig = async (config: Partial<FeedConfig>) => {
    setSaving(true);
    try {
      const payload = { ...feedConfig, ...config, tenant_id: tenantId };
      const { error } = await supabase
        .from('google_feed_config')
        .upsert(payload as any, { onConflict: 'tenant_id' });
      if (error) throw error;
      setFeedConfig(payload as FeedConfig);
      toast({ title: "Feed configuratie opgeslagen" });
    } catch (err: any) {
      toast({ title: "Fout", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const saveMapping = async () => {
    if (!editMapping?.article_group_id || !editMapping?.google_category) return;
    setSaving(true);
    try {
      const group = articleGroups.find(g => g.id === editMapping.article_group_id);
      const payload = {
        ...editMapping,
        tenant_id: tenantId,
        article_group_description: group?.description || editMapping.article_group_id,
      };

      if (editMapping.id) {
        const { error } = await supabase
          .from('google_category_mappings')
          .update(payload as any)
          .eq('id', editMapping.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('google_category_mappings')
          .insert(payload as any);
        if (error) throw error;
      }

      await loadMappings();
      setDialogOpen(false);
      setEditMapping(null);
      toast({ title: "Mapping opgeslagen" });
    } catch (err: any) {
      toast({ title: "Fout", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const deleteMapping = async (id: string) => {
    const { error } = await supabase
      .from('google_category_mappings')
      .delete()
      .eq('id', id);
    if (error) {
      toast({ title: "Fout", description: error.message, variant: "destructive" });
    } else {
      await loadMappings();
      toast({ title: "Mapping verwijderd" });
    }
  };

  const copyFeedUrl = () => {
    navigator.clipboard.writeText(feedUrl);
    toast({ title: "Feed URL gekopieerd" });
  };

  const toggleBulkSelect = (id: string) => {
    setBulkSelectedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllBulk = (groups: typeof articleGroups) => {
    if (bulkSelectedGroups.size === groups.length) {
      setBulkSelectedGroups(new Set());
    } else {
      setBulkSelectedGroups(new Set(groups.map(g => g.id)));
    }
  };

  const saveBulkMappings = async () => {
    if (!bulkMapping.google_category || bulkSelectedGroups.size === 0) return;
    setSaving(true);
    try {
      const rows = Array.from(bulkSelectedGroups).map(groupId => {
        const group = articleGroups.find(g => g.id === groupId);
        return {
          tenant_id: tenantId,
          article_group_id: groupId,
          article_group_description: group?.description || groupId,
          google_category: bulkMapping.google_category,
          gender: bulkMapping.gender,
          age_group: bulkMapping.age_group,
          condition: bulkMapping.condition,
          material: bulkMapping.material || null,
        };
      });

      const { error } = await supabase
        .from('google_category_mappings')
        .insert(rows as any);
      if (error) throw error;

      await loadMappings();
      setBulkDialogOpen(false);
      setBulkSelectedGroups(new Set());
      setBulkMapping({ google_category: '', gender: 'unisex', age_group: 'adult', condition: 'new', material: '' });
      toast({ title: `${rows.length} mappings aangemaakt` });
    } catch (err: any) {
      toast({ title: "Fout", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const unmappedGroups = articleGroups.filter(g => !mappings.find(m => m.article_group_id === g.id));

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
              <Rss className="h-8 w-8" />
              Google Merchant Feed
            </h1>
            <p className="text-muted-foreground mt-1">Beheer de Google Shopping productfeed</p>
          </div>
          <TenantSelector value={tenantId} onChange={setTenantId} />
        </div>

        {!tenantId ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              Selecteer eerst een tenant
            </CardContent>
          </Card>
        ) : loading ? (
          <Card>
            <CardContent className="py-12 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin" />
            </CardContent>
          </Card>
        ) : (
          <Tabs defaultValue="config">
            <TabsList>
              <TabsTrigger value="config">Configuratie</TabsTrigger>
              <TabsTrigger value="mappings">
                Categorie Mappings
                {unmappedGroups.length > 0 && (
                  <Badge variant="destructive" className="ml-2">{unmappedGroups.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="preview">Feed Preview</TabsTrigger>
            </TabsList>

            {/* Config Tab */}
            <TabsContent value="config" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Feed Instellingen</CardTitle>
                  <CardDescription>Configureer de basis instellingen voor de Google Merchant feed</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center gap-4">
                    <Label>Feed actief</Label>
                    <Switch
                      checked={feedConfig?.enabled || false}
                      onCheckedChange={(checked) => saveFeedConfig({ enabled: checked })}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Shop URL</Label>
                      <Input
                        value={feedConfig?.shop_url || ''}
                        placeholder="https://jouwwebshop.nl"
                        onChange={(e) => setFeedConfig(prev => ({ ...prev!, shop_url: e.target.value }))}
                        onBlur={() => feedConfig && saveFeedConfig({ shop_url: feedConfig.shop_url })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Feed Titel</Label>
                      <Input
                        value={feedConfig?.feed_title || ''}
                        placeholder="Google Shopping Feed"
                        onChange={(e) => setFeedConfig(prev => ({ ...prev!, feed_title: e.target.value }))}
                        onBlur={() => feedConfig && saveFeedConfig({ feed_title: feedConfig.feed_title })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Valuta</Label>
                      <Input
                        value={feedConfig?.currency || 'EUR'}
                        onChange={(e) => setFeedConfig(prev => ({ ...prev!, currency: e.target.value }))}
                        onBlur={() => feedConfig && saveFeedConfig({ currency: feedConfig.currency })}
                      />
                    </div>
                  </div>

                  {/* Shipping Rules */}
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-base">Verzendlanden</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const rules = [...(feedConfig?.shipping_rules || []), { country: '', price: 0 }];
                          setFeedConfig(prev => ({ ...prev!, shipping_rules: rules }));
                        }}
                      >
                        <Plus className="h-4 w-4 mr-1" /> Land toevoegen
                      </Button>
                    </div>
                    {(feedConfig?.shipping_rules || []).length === 0 && (
                      <p className="text-sm text-muted-foreground">Nog geen verzendlanden geconfigureerd. Voeg landen toe om verzendkosten in de feed op te nemen.</p>
                    )}
                    {(feedConfig?.shipping_rules || []).map((rule, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          value={rule.country}
                          placeholder="Landcode (bijv. NL)"
                          className="w-32"
                          onChange={(e) => {
                            const rules = [...(feedConfig?.shipping_rules || [])];
                            rules[idx] = { ...rules[idx], country: e.target.value.toUpperCase() };
                            setFeedConfig(prev => ({ ...prev!, shipping_rules: rules }));
                          }}
                          onBlur={() => feedConfig && saveFeedConfig({ shipping_rules: feedConfig.shipping_rules })}
                        />
                        <Input
                          type="number"
                          value={rule.price}
                          placeholder="Prijs"
                          className="w-32"
                          onChange={(e) => {
                            const rules = [...(feedConfig?.shipping_rules || [])];
                            rules[idx] = { ...rules[idx], price: parseFloat(e.target.value) || 0 };
                            setFeedConfig(prev => ({ ...prev!, shipping_rules: rules }));
                          }}
                          onBlur={() => feedConfig && saveFeedConfig({ shipping_rules: feedConfig.shipping_rules })}
                        />
                        <span className="text-sm text-muted-foreground">{feedConfig?.currency || 'EUR'}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            const rules = (feedConfig?.shipping_rules || []).filter((_, i) => i !== idx);
                            setFeedConfig(prev => ({ ...prev!, shipping_rules: rules }));
                            saveFeedConfig({ shipping_rules: rules });
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Feed URL */}
              <Card>
                <CardHeader>
                  <CardTitle>Feed URL</CardTitle>
                  <CardDescription>Gebruik deze URL in Google Merchant Center</CardDescription>
                </CardHeader>
                <CardContent>
                  {feedConfig?.enabled ? (
                    <div className="flex items-center gap-2">
                      <Input readOnly value={feedUrl} className="font-mono text-sm" />
                      <Button variant="outline" size="icon" onClick={copyFeedUrl}>
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="icon" asChild>
                        <a href={feedUrl} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">Activeer de feed om de URL te genereren</p>
                  )}
                </CardContent>
              </Card>

              {/* Stats */}
              {feedStats && (
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <CardContent className="pt-6 text-center">
                      <p className="text-3xl font-bold">{feedStats.total}</p>
                      <p className="text-sm text-muted-foreground">Totaal producten</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6 text-center">
                      <p className="text-3xl font-bold text-green-600">{feedStats.mapped}</p>
                      <p className="text-sm text-muted-foreground">In feed (gemapped)</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-6 text-center">
                      <p className="text-3xl font-bold text-orange-500">{feedStats.unmapped}</p>
                      <p className="text-sm text-muted-foreground">Niet in feed</p>
                    </CardContent>
                  </Card>
                </div>
              )}
            </TabsContent>

            {/* Mappings Tab */}
            <TabsContent value="mappings" className="space-y-4">
            {unmappedGroups.length > 0 && (
                <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-orange-700 dark:text-orange-400">
                      <AlertCircle className="h-5 w-5" />
                      {unmappedGroups.length} artikelgroepen zonder Google categorie
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleAllBulk(unmappedGroups)}
                      >
                        {bulkSelectedGroups.size === unmappedGroups.length ? 'Deselecteer alles' : 'Selecteer alles'}
                      </Button>
                      {bulkSelectedGroups.size > 0 && (
                        <Button
                          size="sm"
                          onClick={() => setBulkDialogOpen(true)}
                        >
                          <CheckSquare className="h-4 w-4 mr-2" />
                          Bulk toewijzen ({bulkSelectedGroups.size})
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">
                            <Checkbox
                              checked={bulkSelectedGroups.size === unmappedGroups.length && unmappedGroups.length > 0}
                              onCheckedChange={() => toggleAllBulk(unmappedGroups)}
                            />
                          </TableHead>
                          <TableHead>Code</TableHead>
                          <TableHead>Beschrijving</TableHead>
                          <TableHead className="text-right">Producten</TableHead>
                          <TableHead className="w-24">Actie</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {unmappedGroups.map(g => (
                          <TableRow key={g.id}>
                            <TableCell>
                              <Checkbox
                                checked={bulkSelectedGroups.has(g.id)}
                                onCheckedChange={() => toggleBulkSelect(g.id)}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-sm">{g.id}</TableCell>
                            <TableCell className="font-medium">{g.description}</TableCell>
                            <TableCell className="text-right">{g.productCount}</TableCell>
                            <TableCell>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setEditMapping({
                                    article_group_id: g.id,
                                    article_group_description: g.description,
                                    google_category: '',
                                    gender: 'unisex',
                                    age_group: 'adult',
                                    condition: 'new',
                                  });
                                  setDialogOpen(true);
                                }}
                              >
                                <Plus className="h-3.5 w-3.5 mr-1" /> Map
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle>Categorie Mappings</CardTitle>
                    <CardDescription>Koppel artikelgroepen aan Google Product Categorieën</CardDescription>
                  </div>
                  <Button onClick={() => {
                    setEditMapping({
                      google_category: '',
                      gender: 'unisex',
                      age_group: 'adult',
                      condition: 'new',
                    });
                    setDialogOpen(true);
                  }}>
                    <Plus className="h-4 w-4 mr-2" /> Mapping toevoegen
                  </Button>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Artikelgroep</TableHead>
                        <TableHead>Google Categorie</TableHead>
                        <TableHead>Geslacht</TableHead>
                        <TableHead>Leeftijd</TableHead>
                        <TableHead>Materiaal</TableHead>
                        <TableHead className="w-24">Acties</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {mappings.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                            Nog geen mappings geconfigureerd
                          </TableCell>
                        </TableRow>
                      ) : mappings.map(m => (
                        <TableRow key={m.id}>
                          <TableCell className="font-medium">{m.article_group_description || m.article_group_id}</TableCell>
                          <TableCell className="text-sm">{m.google_category}</TableCell>
                          <TableCell><Badge variant="secondary">{m.gender}</Badge></TableCell>
                          <TableCell><Badge variant="secondary">{m.age_group}</Badge></TableCell>
                          <TableCell>{m.material || '-'}</TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost" size="icon"
                                onClick={() => { setEditMapping(m); setDialogOpen(true); }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost" size="icon"
                                onClick={() => deleteMapping(m.id)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Preview Tab */}
            <TabsContent value="preview">
              <FeedPreview tenantId={tenantId} feedUrl={feedUrl} enabled={feedConfig?.enabled || false} />
            </TabsContent>
          </Tabs>
        )}

        {/* Edit Mapping Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editMapping?.id ? 'Mapping bewerken' : 'Nieuwe mapping'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Artikelgroep</Label>
                <Select
                  value={editMapping?.article_group_id || ''}
                  onValueChange={(v) => {
                    const group = articleGroups.find(g => g.id === v);
                    setEditMapping(prev => ({
                      ...prev!,
                      article_group_id: v,
                      article_group_description: group?.description || v,
                    }));
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecteer artikelgroep" />
                  </SelectTrigger>
                  <SelectContent>
                    {articleGroups.map(g => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.description} ({g.productCount} producten)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Google Product Categorie</Label>
                <GoogleCategorySearch
                  value={editMapping?.google_category || ''}
                  onSelect={(v) => setEditMapping(prev => ({ ...prev!, google_category: v }))}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Geslacht</Label>
                  <Select
                    value={editMapping?.gender || 'unisex'}
                    onValueChange={(v) => setEditMapping(prev => ({ ...prev!, gender: v }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GENDER_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Leeftijdsgroep</Label>
                  <Select
                    value={editMapping?.age_group || 'adult'}
                    onValueChange={(v) => setEditMapping(prev => ({ ...prev!, age_group: v }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AGE_GROUP_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Conditie</Label>
                  <Select
                    value={editMapping?.condition || 'new'}
                    onValueChange={(v) => setEditMapping(prev => ({ ...prev!, condition: v }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONDITION_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Materiaal (optioneel)</Label>
                <Input
                  value={editMapping?.material || ''}
                  placeholder="bijv. Leer, Textiel"
                  onChange={(e) => setEditMapping(prev => ({ ...prev!, material: e.target.value }))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Annuleren</Button>
              <Button onClick={saveMapping} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Opslaan
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Bulk Mapping Dialog */}
        <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Bulk categorie toewijzen</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Wijs dezelfde Google categorie toe aan <strong>{bulkSelectedGroups.size}</strong> geselecteerde artikelgroepen:
            </p>
            <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
              {Array.from(bulkSelectedGroups).map(id => {
                const g = articleGroups.find(ag => ag.id === id);
                return <Badge key={id} variant="secondary" className="text-xs">{g?.description || id}</Badge>;
              })}
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Google Product Categorie</Label>
                <GoogleCategorySearch
                  value={bulkMapping.google_category}
                  onSelect={(v) => setBulkMapping(prev => ({ ...prev, google_category: v }))}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Geslacht</Label>
                  <Select value={bulkMapping.gender} onValueChange={(v) => setBulkMapping(prev => ({ ...prev, gender: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GENDER_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Leeftijdsgroep</Label>
                  <Select value={bulkMapping.age_group} onValueChange={(v) => setBulkMapping(prev => ({ ...prev, age_group: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AGE_GROUP_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Conditie</Label>
                  <Select value={bulkMapping.condition} onValueChange={(v) => setBulkMapping(prev => ({ ...prev, condition: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONDITION_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Materiaal (optioneel)</Label>
                <Input
                  value={bulkMapping.material}
                  placeholder="bijv. Leer, Textiel"
                  onChange={(e) => setBulkMapping(prev => ({ ...prev, material: e.target.value }))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>Annuleren</Button>
              <Button onClick={saveBulkMappings} disabled={saving || !bulkMapping.google_category}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {bulkSelectedGroups.size} mappings opslaan
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Layout>
  );
};

// Feed Preview Component
function FeedPreview({ tenantId, feedUrl, enabled }: { tenantId: string; feedUrl: string; enabled: boolean }) {
  const [previewData, setPreviewData] = useState<{ totalItems: number; sampleXml: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const loadPreview = async () => {
    if (!enabled) {
      toast({ title: "Feed is niet actief", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(feedUrl);
      if (!response.ok) throw new Error(await response.text());
      const xml = await response.text();
      const itemCount = (xml.match(/<item>/g) || []).length;
      // Show first 3000 chars as sample
      setPreviewData({ totalItems: itemCount, sampleXml: xml.substring(0, 3000) });
    } catch (err: any) {
      toast({ title: "Fout bij laden preview", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Feed Preview</CardTitle>
          <CardDescription>Bekijk een voorbeeld van de gegenereerde feed</CardDescription>
        </div>
        <Button onClick={loadPreview} disabled={loading || !enabled}>
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Rss className="h-4 w-4 mr-2" />}
          Preview laden
        </Button>
      </CardHeader>
      <CardContent>
        {!enabled && (
          <p className="text-muted-foreground text-center py-8">Activeer de feed eerst in de configuratie tab</p>
        )}
        {previewData && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <span className="font-medium">{previewData.totalItems} productvarianten in de feed</span>
            </div>
            <pre className="bg-muted p-4 rounded-lg text-xs overflow-x-auto max-h-96 overflow-y-auto">
              {previewData.sampleXml}
              {previewData.sampleXml.length >= 3000 && '\n\n... (afgekapt)'}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default GoogleFeed;
