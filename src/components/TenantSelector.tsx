import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  active: boolean;
}

interface TenantSelectorProps {
  value: string;
  onChange: (value: string) => void;
  showAll?: boolean;
}

export function TenantSelector({ value, onChange, showAll = false }: TenantSelectorProps) {
  const { data: tenants = [] } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("*")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data as Tenant[];
    },
  });

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[250px]">
        <SelectValue placeholder="Select tenant" />
      </SelectTrigger>
      <SelectContent>
        {showAll && (
          <SelectItem value="all">Alle tenants</SelectItem>
        )}
        {tenants.map((tenant) => (
          <SelectItem key={tenant.id} value={tenant.id}>
            {tenant.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
