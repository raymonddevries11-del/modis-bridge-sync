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
      attribute_definitions: {
        Row: {
          allowed_values: string[]
          created_at: string
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          allowed_values?: string[]
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          allowed_values?: string[]
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      attribute_mappings: {
        Row: {
          attribute_name: string
          code: string
          created_at: string
          id: string
          tenant_id: string | null
          updated_at: string
          value: string
        }
        Insert: {
          attribute_name: string
          code: string
          created_at?: string
          id?: string
          tenant_id?: string | null
          updated_at?: string
          value: string
        }
        Update: {
          attribute_name?: string
          code?: string
          created_at?: string
          id?: string
          tenant_id?: string | null
          updated_at?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribute_mappings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
      changelog: {
        Row: {
          created_at: string
          description: string
          event_type: string
          id: string
          metadata: Json | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          description: string
          event_type: string
          id?: string
          metadata?: Json | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          description?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "changelog_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
          tenant_id: string | null
        }
        Insert: {
          created_at?: string | null
          filename: string
          id?: string
          order_number: string
          storage_path: string
          synced_at?: string | null
          synced_to_sftp?: boolean | null
          tenant_id?: string | null
        }
        Update: {
          created_at?: string | null
          filename?: string
          id?: string
          order_number?: string
          storage_path?: string
          synced_at?: string | null
          synced_to_sftp?: boolean | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "export_files_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      google_category_mappings: {
        Row: {
          age_group: string | null
          article_group_description: string | null
          article_group_id: string
          condition: string | null
          created_at: string
          gender: string | null
          google_category: string
          id: string
          material: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          age_group?: string | null
          article_group_description?: string | null
          article_group_id: string
          condition?: string | null
          created_at?: string
          gender?: string | null
          google_category: string
          id?: string
          material?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          age_group?: string | null
          article_group_description?: string | null
          article_group_id?: string
          condition?: string | null
          created_at?: string
          gender?: string | null
          google_category?: string
          id?: string
          material?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_category_mappings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      google_feed_config: {
        Row: {
          created_at: string
          currency: string | null
          enabled: boolean | null
          fallback_age_group: string | null
          fallback_gender: string | null
          fallback_google_category: string | null
          feed_description: string | null
          feed_title: string | null
          shipping_country: string | null
          shipping_price: number | null
          shipping_rules: Json | null
          shop_url: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string | null
          enabled?: boolean | null
          fallback_age_group?: string | null
          fallback_gender?: string | null
          fallback_google_category?: string | null
          feed_description?: string | null
          feed_title?: string | null
          shipping_country?: string | null
          shipping_price?: number | null
          shipping_rules?: Json | null
          shop_url?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string | null
          enabled?: boolean | null
          fallback_age_group?: string | null
          fallback_gender?: string | null
          fallback_google_category?: string | null
          feed_description?: string | null
          feed_title?: string | null
          shipping_country?: string | null
          shipping_price?: number | null
          shipping_rules?: Json | null
          shop_url?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_feed_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          id: string
          payload: Json
          state: Database["public"]["Enums"]["job_state"]
          tenant_id: string | null
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
          tenant_id?: string | null
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
          tenant_id?: string | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
          tenant_id: string | null
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
          tenant_id?: string | null
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
          tenant_id?: string | null
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
          {
            foreignKeyName: "order_lines_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
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
          tenant_id: string | null
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
          tenant_id?: string | null
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
          tenant_id?: string | null
          totals?: Json
        }
        Relationships: [
          {
            foreignKeyName: "orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_product_syncs: {
        Row: {
          created_at: string
          product_id: string
          reason: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          product_id: string
          reason: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          product_id?: string
          reason?: string
          tenant_id?: string
        }
        Relationships: []
      }
      product_ai_content: {
        Row: {
          ai_features: Json | null
          ai_keywords: string | null
          ai_long_description: string | null
          ai_meta_description: string | null
          ai_meta_title: string | null
          ai_short_description: string | null
          ai_suggested_categories: Json | null
          ai_title: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          generated_at: string | null
          id: string
          product_id: string
          rejected_at: string | null
          rejected_reason: string | null
          status: Database["public"]["Enums"]["ai_content_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          ai_features?: Json | null
          ai_keywords?: string | null
          ai_long_description?: string | null
          ai_meta_description?: string | null
          ai_meta_title?: string | null
          ai_short_description?: string | null
          ai_suggested_categories?: Json | null
          ai_title?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          generated_at?: string | null
          id?: string
          product_id: string
          rejected_at?: string | null
          rejected_reason?: string | null
          status?: Database["public"]["Enums"]["ai_content_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          ai_features?: Json | null
          ai_keywords?: string | null
          ai_long_description?: string | null
          ai_meta_description?: string | null
          ai_meta_title?: string | null
          ai_short_description?: string | null
          ai_suggested_categories?: Json | null
          ai_title?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          generated_at?: string | null
          id?: string
          product_id?: string
          rejected_at?: string | null
          rejected_reason?: string | null
          status?: Database["public"]["Enums"]["ai_content_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_ai_content_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_ai_content_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
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
      product_sync_status: {
        Row: {
          created_at: string
          last_synced_at: string | null
          product_id: string
          sync_count: number
        }
        Insert: {
          created_at?: string
          last_synced_at?: string | null
          product_id: string
          sync_count?: number
        }
        Update: {
          created_at?: string
          last_synced_at?: string | null
          product_id?: string
          sync_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "product_sync_status_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          article_group: Json | null
          attributes: Json | null
          brand_id: string | null
          categories: Json | null
          color: Json | null
          cost_price: number | null
          created_at: string
          discount_percentage: number | null
          field_sources: Json
          id: string
          images: Json | null
          internal_description: string | null
          is_promotion: boolean | null
          locked_fields: string[]
          meta_description: string | null
          meta_keywords: string | null
          meta_title: string | null
          outlet_sale: boolean | null
          plan_period: string | null
          product_type: string
          sku: string
          supplier_id: string | null
          tags: string[] | null
          tax_code: string | null
          tenant_id: string | null
          title: string
          updated_at: string
          url_key: string | null
          webshop_date: string | null
          webshop_text: string | null
          webshop_text_en: string | null
        }
        Insert: {
          article_group?: Json | null
          attributes?: Json | null
          brand_id?: string | null
          categories?: Json | null
          color?: Json | null
          cost_price?: number | null
          created_at?: string
          discount_percentage?: number | null
          field_sources?: Json
          id?: string
          images?: Json | null
          internal_description?: string | null
          is_promotion?: boolean | null
          locked_fields?: string[]
          meta_description?: string | null
          meta_keywords?: string | null
          meta_title?: string | null
          outlet_sale?: boolean | null
          plan_period?: string | null
          product_type?: string
          sku: string
          supplier_id?: string | null
          tags?: string[] | null
          tax_code?: string | null
          tenant_id?: string | null
          title: string
          updated_at?: string
          url_key?: string | null
          webshop_date?: string | null
          webshop_text?: string | null
          webshop_text_en?: string | null
        }
        Update: {
          article_group?: Json | null
          attributes?: Json | null
          brand_id?: string | null
          categories?: Json | null
          color?: Json | null
          cost_price?: number | null
          created_at?: string
          discount_percentage?: number | null
          field_sources?: Json
          id?: string
          images?: Json | null
          internal_description?: string | null
          is_promotion?: boolean | null
          locked_fields?: string[]
          meta_description?: string | null
          meta_keywords?: string | null
          meta_title?: string | null
          outlet_sale?: boolean | null
          plan_period?: string | null
          product_type?: string
          sku?: string
          supplier_id?: string | null
          tags?: string[] | null
          tax_code?: string | null
          tenant_id?: string | null
          title?: string
          updated_at?: string
          url_key?: string | null
          webshop_date?: string | null
          webshop_text?: string | null
          webshop_text_en?: string | null
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
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
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
      tenant_config: {
        Row: {
          sftp_inbound_path: string
          sftp_outbound_path: string
          tenant_id: string
          updated_at: string
          woocommerce_consumer_key: string
          woocommerce_consumer_secret: string
          woocommerce_url: string
        }
        Insert: {
          sftp_inbound_path: string
          sftp_outbound_path: string
          tenant_id: string
          updated_at?: string
          woocommerce_consumer_key: string
          woocommerce_consumer_secret: string
          woocommerce_url: string
        }
        Update: {
          sftp_inbound_path?: string
          sftp_outbound_path?: string
          tenant_id?: string
          updated_at?: string
          woocommerce_consumer_key?: string
          woocommerce_consumer_secret?: string
          woocommerce_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      variants: {
        Row: {
          active: boolean
          allow_backorder: boolean | null
          created_at: string
          ean: string | null
          id: string
          maat_id: string
          maat_web: string | null
          product_id: string
          size_label: string
          size_type: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          allow_backorder?: boolean | null
          created_at?: string
          ean?: string | null
          id?: string
          maat_id: string
          maat_web?: string | null
          product_id: string
          size_label: string
          size_type?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          allow_backorder?: boolean | null
          created_at?: string
          ean?: string | null
          id?: string
          maat_id?: string
          maat_web?: string | null
          product_id?: string
          size_label?: string
          size_type?: string
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
      xml_validation_logs: {
        Row: {
          created_at: string
          errors: Json
          file_name: string
          file_size: number | null
          file_type: string
          id: string
          is_valid: boolean
          stats: Json
          tenant_id: string
          validated_at: string
          warnings: Json
        }
        Insert: {
          created_at?: string
          errors?: Json
          file_name: string
          file_size?: number | null
          file_type: string
          id?: string
          is_valid?: boolean
          stats?: Json
          tenant_id: string
          validated_at?: string
          warnings?: Json
        }
        Update: {
          created_at?: string
          errors?: Json
          file_name?: string
          file_size?: number | null
          file_type?: string
          id?: string
          is_valid?: boolean
          stats?: Json
          tenant_id?: string
          validated_at?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "xml_validation_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_batch_sync_jobs: { Args: never; Returns: undefined }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      ai_content_status: "pending" | "generated" | "approved" | "rejected"
      app_role: "admin" | "user"
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
      ai_content_status: ["pending", "generated", "approved", "rejected"],
      app_role: ["admin", "user"],
      job_state: ["ready", "processing", "done", "error"],
    },
  },
} as const
