import { useCallback, useEffect, useMemo, useState } from "react";
import { buildAtlasLayout } from "@/lib/buildAtlasLayout";
import { AtlasLayout, ConnectionGraphDTO } from "@/types";

interface UseAtlasDataOptions {
  graphUrl: string;
  rootLabel?: string;
}

interface UseAtlasDataResult {
  layout: AtlasLayout | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAtlasData(options: UseAtlasDataOptions): UseAtlasDataResult {
  const { graphUrl, rootLabel } = options;
  const [layout, setLayout] = useState<AtlasLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const resolvedRoot = rootLabel?.trim() ? rootLabel.trim() : undefined;

  useEffect(() => {
    const controller = new AbortController();

    const fetchGraph = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch(graphUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch connection graph (${response.status}).`);
        }
        const payload = (await response.json()) as ConnectionGraphDTO;
        const baseHref = new URL("./", response.url).toString();
        const nextLayout = buildAtlasLayout(payload, {
          rootOverride: resolvedRoot,
          assetBaseUrl: baseHref,
        });
        setLayout(nextLayout);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setLayout(null);
      } finally {
        setLoading(false);
      }
    };

    fetchGraph().catch((err) => {
      console.error(err);
    });

    return () => {
      controller.abort();
    };
  }, [graphUrl, resolvedRoot, nonce]);

  const reload = useCallback(() => {
    setNonce((value: number) => value + 1);
  }, []);

  return useMemo(
    () => ({ layout, loading, error, reload }),
    [layout, loading, error, reload]
  );
}
