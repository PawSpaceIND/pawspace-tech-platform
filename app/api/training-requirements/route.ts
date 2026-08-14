import { authorize } from "../../../lib/server-auth";

type Db = Awaited<ReturnType<typeof database>>;

async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

const defaults = [
  "Toilet routine",
  "Biting & chewing",
  "Leash walking",
  "Recall",
  "Basic obedience",
  "Socialisation",
  "Excess barking",
  "Separation anxiety",
];

async function ensureRequirements(db: Db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS training_requirements (id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL UNIQUE,sort_order INTEGER NOT NULL,active INTEGER DEFAULT 1 NOT NULL,version INTEGER DEFAULT 1 NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  ).run();
  const now = Date.now();
  for (const [index, label] of defaults.entries()) {
    await db.prepare(
      "INSERT OR IGNORE INTO training_requirements (id,label,sort_order,active,version,updated_by,updated_at) VALUES (?,?,?,1,1,'founder_seed',?)",
    ).bind(`training_requirement_${index + 1}`, label, index + 1, now).run();
  }
}

export async function GET() {
  try {
    const db = await database();
    await ensureRequirements(db);
    const rows = await db.prepare(
      "SELECT id,label,sort_order,active,version FROM training_requirements ORDER BY sort_order,label",
    ).all();
    return Response.json({ data: rows.results });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Training requirements could not load" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    // Finding D3: catalogue mutation requires server-authoritative staff authorization; the actor
    // identity is derived from the session, never a hardcoded/client value.
    const actor = await authorize(request, "scheduling.manage");
    const db = await database();
    await ensureRequirements(db);
    const body = await request.json() as { label?: string };
    const label = body.label?.trim();
    if (!label || label.length < 3 || label.length > 80) {
      return Response.json({ error: "Enter a requirement between 3 and 80 characters" }, { status: 400 });
    }
    const order = await db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 AS next_order FROM training_requirements").first<{ next_order: number }>();
    const id = `training_requirement_${crypto.randomUUID().slice(0, 12)}`;
    await db.prepare(
      "INSERT INTO training_requirements (id,label,sort_order,active,version,updated_by,updated_at) VALUES (?,?,?,1,1,?,?)",
    ).bind(id, label, Number(order?.next_order ?? 1), actor.email, Date.now()).run();
    return Response.json({ data: { id, label, active: 1 } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "Requirement was not added" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await authorize(request, "scheduling.manage");
    const db = await database();
    await ensureRequirements(db);
    const body = await request.json() as { id?: string; label?: string; active?: boolean; sortOrder?: number };
    if (!body.id) return Response.json({ error: "Requirement id is required" }, { status: 400 });
    const current = await db.prepare("SELECT * FROM training_requirements WHERE id=?").bind(body.id).first();
    if (!current) return Response.json({ error: "Requirement not found" }, { status: 404 });
    const label = body.label?.trim() || String(current.label);
    if (label.length < 3 || label.length > 80) return Response.json({ error: "Invalid requirement label" }, { status: 400 });
    await db.prepare(
      "UPDATE training_requirements SET label=?,active=?,sort_order=?,version=version+1,updated_by=?,updated_at=? WHERE id=?",
    ).bind(label, body.active === undefined ? Number(current.active) : body.active ? 1 : 0, body.sortOrder ?? Number(current.sort_order), actor.email, Date.now(), body.id).run();
    return Response.json({ data: { id: body.id, label } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "Requirement was not updated" },
      { status: 500 },
    );
  }
}
