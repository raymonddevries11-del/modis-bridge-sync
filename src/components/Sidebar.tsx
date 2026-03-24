import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Settings,
  Activity,
  Building2,
  Database,
  LogOut,
  Rss,
  Send,
  Map,
  BarChart3,
  ChevronDown,
  ClipboardCheck,
  Image,
  ScanSearch,
  HeartPulse,
  AlertTriangle,
  ArrowLeftRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: "",
    items: [
      { name: "Dashboard", href: "/", icon: LayoutDashboard },
    ],
  },
  {
    label: "Catalog",
    items: [
      { name: "Products", href: "/products", icon: Package },
      { name: "Orders", href: "/orders", icon: ShoppingCart },
      { name: "Validation", href: "/validation", icon: ClipboardCheck },
      { name: "Catalog Data", href: "/catalog-data", icon: Database },
      { name: "Image Health", href: "/image-health", icon: Image },
    ],
  },
  {
    label: "Channels",
    items: [
      { name: "Google Shopping", href: "/channels/google", icon: Rss },
      { name: "WooCommerce", href: "/channels/woocommerce", icon: Send },
      { name: "Sync Status", href: "/sync-status", icon: ArrowLeftRight },
    ],
  },
  {
    label: "Configuration",
    items: [
      { name: "Mappings & Rules", href: "/mappings", icon: Map },
      { name: "Tenants", href: "/tenants", icon: Building2 },
    ],
  },
  {
    label: "Activity",
    items: [
      { name: "Jobs & Logs", href: "/activity", icon: Activity },
      { name: "Pipeline Health", href: "/pipeline-health", icon: HeartPulse },
      { name: "Error Dashboard", href: "/error-dashboard", icon: AlertTriangle },
      { name: "Trigger Audit", href: "/trigger-audit", icon: ScanSearch },
    ],
  },
];

export const Sidebar = () => {
  const location = useLocation();
  const { signOut } = useAuth();

  const isActive = (href: string) => {
    if (href === "/") return location.pathname === "/";
    return location.pathname.startsWith(href);
  };

  return (
    <aside className="w-[260px] min-w-[260px] bg-sidebar border-r border-sidebar-border flex flex-col h-screen">
      {/* Brand */}
      <div className="flex items-center gap-3 h-14 px-5 border-b border-sidebar-border">
        <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
          <span className="text-primary-foreground text-xs font-bold">M</span>
        </div>
        <span className="text-sm font-semibold text-foreground">Modis Bridge</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {navGroups.map((group, gi) => (
          <div key={gi} className={cn("mb-1", gi > 0 && "mt-4")}>
            {group.label && (
              <span className="px-3 mb-1 block text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/60">
                {group.label}
              </span>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-muted hover:text-foreground"
                    )}
                  >
                    <item.icon className="h-4 w-4 flex-shrink-0" />
                    {item.name}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-sidebar-border flex flex-col gap-1">
        <Link
          to="/settings"
          className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors",
            isActive("/settings")
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-muted hover:text-foreground"
          )}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
        <button
          onClick={signOut}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium text-sidebar-foreground hover:bg-sidebar-muted hover:text-foreground transition-colors w-full text-left"
        >
          <LogOut className="h-4 w-4" />
          Uitloggen
        </button>
      </div>
    </aside>
  );
};
