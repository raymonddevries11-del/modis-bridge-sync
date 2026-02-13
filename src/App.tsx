import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import Products from "./pages/Products";
import ProductDetail from "./pages/ProductDetail";
import Orders from "./pages/Orders";
import Settings from "./pages/Settings";
import Tenants from "./pages/Tenants";
import ChannelGoogle from "./pages/ChannelGoogle";
import ChannelWooCommerce from "./pages/ChannelWooCommerce";
import Mappings from "./pages/Mappings";
import ActivityPage from "./pages/ActivityPage";
import Validation from "./pages/Validation";
import CatalogData from "./pages/CatalogData";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/products" element={<ProtectedRoute><Products /></ProtectedRoute>} />
          <Route path="/products/:id" element={<ProtectedRoute><ProductDetail /></ProtectedRoute>} />
          <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
          <Route path="/channels/google" element={<ProtectedRoute><ChannelGoogle /></ProtectedRoute>} />
          <Route path="/channels/woocommerce" element={<ProtectedRoute><ChannelWooCommerce /></ProtectedRoute>} />
          <Route path="/mappings" element={<ProtectedRoute><Mappings /></ProtectedRoute>} />
          <Route path="/tenants" element={<ProtectedRoute><Tenants /></ProtectedRoute>} />
          <Route path="/activity" element={<ProtectedRoute><ActivityPage /></ProtectedRoute>} />
          <Route path="/validation" element={<ProtectedRoute><Validation /></ProtectedRoute>} />
          <Route path="/catalog-data" element={<ProtectedRoute><CatalogData /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
          {/* Legacy redirects */}
          <Route path="/google-feed" element={<Navigate to="/channels/google" replace />} />
          <Route path="/jobs" element={<Navigate to="/activity?tab=jobs" replace />} />
          <Route path="/logs" element={<Navigate to="/activity?tab=logs" replace />} />
          <Route path="/changelog" element={<Navigate to="/activity?tab=changelog" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
