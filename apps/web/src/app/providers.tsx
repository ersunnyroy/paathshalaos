'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { shouldRetry } from '@/lib/query';

/**
 * One query cache per browser tab.
 *
 * Created in state rather than at module scope so a server render never shares
 * a cache between two people. Thirty seconds of freshness is enough to make
 * moving between screens instant without showing a register that is minutes old.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: true },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
