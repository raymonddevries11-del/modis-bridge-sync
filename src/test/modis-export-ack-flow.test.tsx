import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-ignore - types may lag behind runtime
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrderExportAckDashboard } from "@/components/orders/OrderExportAckDashboard";

// ── Mock Supabase ──
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: (...args: any[]) => {
        mockSelect(...args);
        return {
          eq: (...eqArgs: any[]) => {
            mockEq(...eqArgs);
            return {
              order: (...orderArgs: any[]) => {
                mockOrder(...orderArgs);
                return {
                  limit: (...limitArgs: any[]) => {
                    mockLimit(...limitArgs);
                    return Promise.resolve({ data: mockData, error: null });
                  },
                };
              },
            };
          },
        };
      },
    })),
  },
}));

let mockData: any[] = [];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// ── Fixtures ──
const TENANT = "test-tenant-id";

function makeExport(overrides: Partial<any> = {}) {
  return {
    id: crypto.randomUUID(),
    filename: `order_123_${Date.now()}.xml`,
    order_number: "123",
    storage_path: "orders/123.xml",
    synced_to_sftp: false,
    ack_status: "pending",
    created_at: new Date().toISOString(),
    synced_at: null,
    uploaded_to_sftp_at: null,
    retry_count: 0,
    max_retries: 3,
    last_retry_at: null,
    ...overrides,
  };
}

// ── Tests ──

describe("Modis Export ACK Flow – End-to-end", () => {
  beforeEach(() => {
    mockData = [];
    vi.clearAllMocks();
  });

  it("renders empty state when no exports exist", async () => {
    mockData = [];
    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("Geen exports gevonden")).toBeInTheDocument();
    });
  });

  it("shows correct KPI counts for mixed statuses", async () => {
    mockData = [
      makeExport({ ack_status: "pending" }),
      makeExport({ ack_status: "pending" }),
      makeExport({ ack_status: "uploaded" }),
      makeExport({ ack_status: "acked" }),
      makeExport({ ack_status: "acked" }),
      makeExport({ ack_status: "acked" }),
      makeExport({ ack_status: "timeout" }),
      makeExport({ ack_status: "quarantined" }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      // Find all bold numbers – order matches statusConfig keys
      const boldNumbers = screen.getAllByText(/^\d+$/).filter(
        (el) => el.className.includes("font-bold")
      );
      // pending=2, uploaded=1, acked=3, timeout=1, quarantined=1
      expect(boldNumbers.map((el) => el.textContent)).toEqual(["2", "1", "3", "1", "1"]);
    });
  });

  it("displays order number and filename for each export", async () => {
    mockData = [
      makeExport({ order_number: "ORD-999", filename: "order_999_test.xml", ack_status: "uploaded" }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("ORD-999")).toBeInTheDocument();
      expect(screen.getByText("order_999_test.xml")).toBeInTheDocument();
    });
  });

  it("shows correct status badge label per ack_status", async () => {
    mockData = [
      makeExport({ ack_status: "pending", order_number: "P1" }),
      makeExport({ ack_status: "uploaded", order_number: "U1" }),
      makeExport({ ack_status: "acked", order_number: "A1" }),
      makeExport({ ack_status: "timeout", order_number: "T1" }),
      makeExport({ ack_status: "quarantined", order_number: "Q1" }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      // Badge labels in list rows (each status label appears twice: once in KPI, once in badge)
      expect(screen.getAllByText("Wacht op upload").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Op SFTP, wacht op ACK").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Opgepikt door Modis").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Timeout – wordt herstart").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Quarantaine").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows retry count for retried exports", async () => {
    mockData = [
      makeExport({ ack_status: "uploaded", retry_count: 2, max_retries: 3, order_number: "R1" }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("poging 2/3")).toBeInTheDocument();
    });
  });

  it("hides retry count when retry_count is 0", async () => {
    mockData = [
      makeExport({ ack_status: "pending", retry_count: 0, order_number: "N1" }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("N1")).toBeInTheDocument();
    });
    expect(screen.queryByText(/poging/)).not.toBeInTheDocument();
  });

  it("shows quarantined exports with correct styling", async () => {
    mockData = [
      makeExport({
        ack_status: "quarantined",
        retry_count: 3,
        max_retries: 3,
        order_number: "QR1",
      }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("QR1")).toBeInTheDocument();
      expect(screen.getByText("poging 3/3")).toBeInTheDocument();
      // Quarantaine badge should be present in list
      const badges = screen.getAllByText("Quarantaine");
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("does not fetch when tenantId is empty", async () => {
    mockData = [makeExport()];
    render(<OrderExportAckDashboard tenantId="" />, { wrapper });

    await waitFor(() => {
      // Should show empty state because queryFn returns [] for empty tenantId
      expect(screen.getByText("Geen exports gevonden")).toBeInTheDocument();
    });
  });
});

describe("Modis Export ACK Flow – Status transitions", () => {
  beforeEach(() => {
    mockData = [];
    vi.clearAllMocks();
  });

  it("pending → uploaded transition is reflected in KPIs", async () => {
    // Simulate a file that moved from pending to uploaded
    mockData = [
      makeExport({
        ack_status: "uploaded",
        uploaded_to_sftp_at: new Date().toISOString(),
        synced_to_sftp: true,
      }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      const boldNumbers = screen.getAllByText(/^\d+$/).filter(
        (el) => el.className.includes("font-bold")
      );
      // pending=0, uploaded=1, acked=0, timeout=0, quarantined=0
      expect(boldNumbers.map((el) => el.textContent)).toEqual(["0", "1", "0", "0", "0"]);
    });
  });

  it("timeout with retries exhausted shows quarantined state", async () => {
    mockData = [
      makeExport({
        ack_status: "quarantined",
        retry_count: 3,
        max_retries: 3,
      }),
    ];

    render(<OrderExportAckDashboard tenantId={TENANT} />, { wrapper });

    await waitFor(() => {
      const boldNumbers = screen.getAllByText(/^\d+$/).filter(
        (el) => el.className.includes("font-bold")
      );
      // pending=0, uploaded=0, acked=0, timeout=0, quarantined=1
      expect(boldNumbers.map((el) => el.textContent)).toEqual(["0", "0", "0", "0", "1"]);
    });
  });
});
