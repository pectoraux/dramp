"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Forcefully replace the data (e.g. after a mutation, to avoid waiting for the next tick). */
  setData: (data: T | null) => void;
}

/**
 * Polls a JSON endpoint on an interval.
 * Pass `null` for url to pause polling.
 */
export function usePolling<T>(
  url: string | null,
  intervalMs = 2000,
): PollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(url);
  const intervalRef = useRef<number | null>(null);

  const fetchData = useCallback(async () => {
    const currentUrl = urlRef.current;
    if (!currentUrl) {
      setLoading(false);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(currentUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${txt ? `: ${txt}` : ""}`);
      }
      const json = (await res.json()) as T;
      setData(json);
      setError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep urlRef in sync and trigger initial fetch + reset state on URL change.
  useEffect(() => {
    urlRef.current = url;
    if (url) {
      setLoading(true);
      setError(null);
      fetchData();
    } else {
      setLoading(false);
    }
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [url, fetchData]);

  // Interval ticker.
  useEffect(() => {
    if (!url) return;
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(() => {
      fetchData();
    }, intervalMs);
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [url, intervalMs, fetchData]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch, setData };
}
