"use client";
import { useState } from "react";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

/** Fetch helper for the app's own JSON API. Unwraps `{data}` and throws ApiError on `{error}`. */
export async function api<T = unknown>(url: string, init?: Omit<RequestInit, "body"> & { body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  let json: { data?: T; error?: { code: string; message: string; details?: unknown } } | null = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || json?.error) {
    throw new ApiError(json?.error?.code ?? "INTERNAL", json?.error?.message ?? "Request failed. Please try again.", res.status, json?.error?.details);
  }
  return json?.data as T;
}

/** Tracks pending/error state for a mutation. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        const f = (e.details as { fields?: Record<string, string> } | undefined)?.fields;
        if (f) setFieldErrors(f);
      } else {
        setError("Something went wrong. Please try again.");
      }
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error, fieldErrors, setError };
}
