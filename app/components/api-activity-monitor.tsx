"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Why this exists.
 *
 * Every staff screen (/team, /control, /admin) fetches its own data on mount and renders
 * `{error && <box/>}{data && <body/>}`. Both are falsy until the request settles, so the page paints
 * its header and then *nothing at all*. A slow cold-D1 aggregate, a null payload and a completely
 * broken endpoint are visually identical: a heading floating over an empty page. That is what
 * "nothing is working" looks like, and 26 of the 44 Team pages that fetch on mount have no loading
 * or empty rendering of any kind.
 *
 * Fixing 44 pages one at a time leaves the next new page free to reintroduce the same hole, so the
 * signal is captured once, here, for every page at once: an in-flight request says it is loading, an
 * expired sign-in says so and offers the way back, and a failed endpoint names itself and its status
 * instead of resolving to a blank screen.
 *
 * It also repairs one thing, deliberately. Every page reads its errors with `response.json()`. When a
 * failing endpoint answers with text or HTML instead - "Internal Server Error", a platform error
 * page, a proxy notice - that call throws, and the page shows the reader
 * `Unexpected token 'I', "Internal S"... is not valid JSON`. A browser sweep found 65 routes doing
 * exactly that. So a non-JSON error body is re-wrapped as `{ error: <the text the server sent> }`
 * with its status untouched, and the page shows what the server actually said. Nothing is hidden:
 * the status, the failure and the server's own words all survive; only the encoding changes.
 *
 * Successful responses are never touched, and nothing is ever retried or swallowed.
 */

type Failure = { endpoint: string; status: number };

/** A request has to be slow enough to be worth announcing, or the bar flashes on every quick call. */
const SLOW_REQUEST_MS = 400;

function endpointOf(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return raw;
  }
}

function isSameOriginApi(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** An HTML error page is not a message; fall back to the status when the body is markup or empty. */
function readableError(body: string, response: Response): string {
  const trimmed = body.trim();
  if (!trimmed || trimmed.startsWith("<")) return response.statusText || `The server answered ${response.status}.`;
  return trimmed.slice(0, 300);
}

export default function ApiActivityMonitor() {
  const pending = useRef(0);
  const [inFlight, setInFlight] = useState(0);
  const [slow, setSlow] = useState(false);
  const [signInExpired, setSignInExpired] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    const original = window.fetch;
    let live = true;

    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
      if (!isSameOriginApi(input)) return original(input, init);
      if (live) {
        pending.current += 1;
        // A fresh burst of requests has to earn the bar again rather than inherit the last one's.
        if (pending.current === 1) setSlow(false);
        setInFlight(pending.current);
      }
      try {
        const response = await original(input, init);
        if (response.ok) return response;

        if (live && (response.status === 401 || response.status >= 500)) {
          // clone() so the page still reads its own body exactly once, untouched.
          const body = await response.clone().json().catch(() => ({}) as Record<string, unknown>);
          if (response.status === 401 && body.code === "sign_in_required") setSignInExpired(true);
          else if (response.status >= 500) setFailure({ endpoint: endpointOf(input), status: response.status });
        }

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("json")) return response;
        const text = await response.clone().text().catch(() => "");
        return new Response(JSON.stringify({ error: readableError(text, response) }), {
          status: response.status,
          statusText: response.statusText,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        if (live) setFailure({ endpoint: endpointOf(input), status: 0 });
        throw error;
      } finally {
        if (live) {
          pending.current = Math.max(0, pending.current - 1);
          setInFlight(pending.current);
        }
      }
    };

    return () => {
      live = false;
      window.fetch = original;
    };
  }, []);

  useEffect(() => {
    if (inFlight === 0) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_REQUEST_MS);
    return () => window.clearTimeout(timer);
  }, [inFlight]);

  return (
    <>
      {slow && inFlight > 0 && (
        <div className="api-activity-bar" role="status" aria-live="polite">
          <span />
          <b>Loading {inFlight === 1 ? "data" : `${inFlight} requests`}…</b>
        </div>
      )}
      {signInExpired && (
        <div className="api-activity-notice api-activity-notice--auth" role="alert">
          <b>Your staging sign-in has expired.</b>
          <span>Pages will keep loading empty until you sign in again.</span>
          <a href="/staging-login">Sign in again</a>
        </div>
      )}
      {!signInExpired && failure && (
        <div className="api-activity-notice api-activity-notice--error" role="alert">
          <b>{failure.endpoint} failed</b>
          <span>{failure.status === 0 ? "The request could not be sent." : `The server answered ${failure.status}.`} This screen may be missing data.</span>
          <button type="button" onClick={() => setFailure(null)}>Dismiss</button>
        </div>
      )}
    </>
  );
}
