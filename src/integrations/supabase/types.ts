export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          id: string
          key_hash: string
          last_used_at: string | null
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_hash: string
          last_used_at?: string | null
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          key_hash?: string
          last_used_at?: string | null
          name?: string
        }
        Relationships: []
      }
      brands: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      config: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      export_files: {
        Row: {
          created_at: string | null
          filename: string
          id: string
          order_number: string
          storage_path: string
          synced_at: string | null
          synced_to_sftp: boolean | null
        }
        Insert: {
          created_at?: string | null
          filename: string
          id?: string
          order_number: string
          storage_path: string
          synced_at?: string | null
          synced_to_sftp?: boolean | null
        }
        Update: {
          created_at?: string | null
          filename?: string
          id?: string
          order_number?: string
          storage_path?: string
          synced_at?: string | null
          synced_to_sftp?: boolean | null
        }
        Relationships: []
      }
      jobs: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          id: string
          payload: Json
          state: Database["public"]["Enums"]["job_state"]
          type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          id?: string
          payload: Json
          state?: Database["public"]["Enums"]["job_state"]
          type: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          id?: string
          payload?: Json
          state?: Database["public"]["Enums"]["job_state"]
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      order_lines: {
        Row: {
          attributes: Json | null
          ean: string | null
          id: string
          name: string
          order_number: string
          qty: number
          sku: string
          unit_price: number
          vat_rate: number
        }
        Insert: {
          attributes?: Json | null
          ean?: string | null
          id?: string
          name: string
          order_number: string
          qty: number
          sku: string
          unit_price: number
          vat_rate: number
        }
        Update: {
          attributes?: Json | null
          ean?: string | null
          id?: string
          name?: string
          order_number?: string
          qty?: number
          sku?: string
          unit_price?: number
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_lines_order_number_fkey"
            columns: ["order_number"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["order_number"]
          },
        ]
      }
      orders: {
        Row: {
          billing: Json
          created_at: string
          currency: string | null
          customer: Json
          order_number: string
          paid_at: string | null
          shipping: Json
          status: string
          totals: Json
        }
        Insert: {
          billing: Json
          created_at?: string
          currency?: string | null
          customer: Json
          order_number: string
          paid_at?: string | null
          shipping: Json
          status: string
          totals: Json
        }
        Update: {
          billing?: Json
          created_at?: string
          currency?: string | null
          customer?: Json
          order_number?: string
          paid_at?: string | null
          shipping?: Json
          status?: string
          totals?: Json
        }
        Relationships: []
      }
      product_prices: {
        Row: {
          currency: string | null
          list: number | null
          product_id: string
          regular: number | null
          updated_at: string
        }
        Insert: {
          currency?: string | null
          list?: number | null
          product_id: string
          regular?: number | null
          updated_at?: string
        }
        Update: {
          currency?: string | null
          list?: number | null
          product_id?: string
          regular?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_prices_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          brand_id: string | null
          color: Json | null
          created_at: string
          id: string
          images: Json | null
          sku: string
          supplier_id: string | null
          tax_code: string | null
          title: string
          updated_at: string
          url_key: string | null
        }
        Insert: {
          brand_id?: string | null
          color?: Json | null
          created_at?: string
          id?: string
          images?: Json | null
          sku: string
          supplier_id?: string | null
          tax_code?: string | null
          title: string
          updated_at?: string
          url_key?: string | null
        }
        Update: {
          brand_id?: string | null
          color?: Json | null
          created_at?: string
          id?: string
          images?: Json | null
          sku?: string
          supplier_id?: string | null
          tax_code?: string | null
          title?: string
          updated_at?: string
          url_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_by_store: {
        Row: {
          qty: number
          store_id: string
          updated_at: string
          variant_id: string
        }
        Insert: {
          qty?: number
          store_id: string
          updated_at?: string
          variant_id: string
        }
        Update: {
          qty?: number
          store_id?: string
          updated_at?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_by_store_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "variants"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_totals: {
        Row: {
          qty: number
          updated_at: string
          variant_id: string
        }
        Insert: {
          qty?: number
          updated_at?: string
          variant_id: string
        }
        Update: {
          qty?: number
          updated_at?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_totals_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: true
            referencedRelation: "variants"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      variants: {
        Row: {
          active: boolean
          created_at: string
          ean: string | null
          id: string
          maat_id: string
          product_id: string
          size_label: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          ean?: string | null
          id?: string
          maat_id: string
          product_id: string
          size_label: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          ean?: string | null
          id?: string
          maat_id?: string
          product_id?: string
          size_label?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      job_state: "ready" | "processing" | "done" | "error"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      job_state: ["ready", "processing", "done", "error"],
    },
  },
} as const
