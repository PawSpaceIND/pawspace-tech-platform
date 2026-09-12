export function handleEdgeHealth(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/healthz" || request.method !== "GET") return null;

  return Response.json(
    { status: "ok" },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}
