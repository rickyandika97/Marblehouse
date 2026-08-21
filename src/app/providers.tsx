"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

/**
 * TanStack Query provider (§5.2).
 *
 * Phase 1 screens are server-rendered and do not use it yet; it is wired in
 * now so Phase 2's sale screen has caching, retry and optimistic updates
 * available without a retrofit.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Shop wifi is unreliable (R-1). Retry twice, then surface it.
            retry: 2,
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
          mutations: {
            // Never auto-retry a mutation: a retried sale is a duplicate sale.
            // Idempotency keys arrive in Phase 2 (NF-5).
            retry: 0,
          },
        },
      })
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
      storageKey="marblehouse-theme"
    >
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
