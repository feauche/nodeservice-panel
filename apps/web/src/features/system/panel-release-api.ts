import { type PanelRelease, panelReleaseSchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const panelReleaseApi = {
  latest: (signal?: AbortSignal): Promise<PanelRelease> =>
    api.get('/system/release', panelReleaseSchema, signal),
};

export function usePanelRelease() {
  return useQuery({
    queryKey: ['system', 'release'],
    queryFn: ({ signal }) => panelReleaseApi.latest(signal),
    staleTime: 15 * 60_000,
    refetchInterval: 15 * 60_000,
  });
}
