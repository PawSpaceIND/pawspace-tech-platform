"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { loadFoodOps } from "../../../../lib/food-ops-client";

/**
 * The list of canonical Food orders, for the two workspaces that could previously only be deep-linked.
 *
 * /team/operations/food/fulfilment and /team/operations/food/proof both read `orderId` from the query
 * string, and with no `orderId` each rendered the single sentence "Open with a canonical Food order
 * ID." and a link back to Operations home. Nothing anywhere offered that ID: the Food exception queue
 * linked to `proof` only from a selected order, and to `fulfilment` from nowhere at all. So an
 * operator who arrived at either screen by navigation was told to supply something the product never
 * gave them. The queue already reads every canonical order; this offers them.
 */
export type FoodWorkspace = "fulfilment" | "proof";
export type FoodOrderChoice = { id: string; label: string; href: string; flags: string[] };

const text = (value: unknown) => String(value ?? "").trim();

/** Pure: the choices a picker renders for one workspace, from the Food Operations snapshot's orders. */
export function foodWorkspaceChoices(orders: Array<Record<string, unknown>>, workspace: FoodWorkspace): FoodOrderChoice[] {
  return (orders || [])
    .map((order) => {
      const id = text(order.id);
      if (!id) return null;
      const item = text(order.item_name) || text(order.sku) || "Food order";
      const status = (text(order.fulfilment_status) || text(order.status) || "not set").replaceAll("_", " ");
      const flags = Array.isArray(order.exceptionFlags) ? order.exceptionFlags.map(String) : [];
      return {
        id,
        label: `${id} · ${item} · ${status}`,
        href: `/team/operations/food/${workspace}?orderId=${encodeURIComponent(id)}`,
        flags,
      };
    })
    .filter((choice): choice is FoodOrderChoice => choice !== null)
    // Orders carrying an exception first: that is who the operator came to this screen about.
    .sort((a, b) => (b.flags.length ? 1 : 0) - (a.flags.length ? 1 : 0) || a.id.localeCompare(b.id));
}

export default function FoodOrderPicker({ workspace, title }: { workspace: FoodWorkspace; title: string }) {
  const [choices, setChoices] = useState<FoodOrderChoice[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void loadFoodOps()
      .then((data) => { if (active) setChoices(foodWorkspaceChoices(data.orders, workspace)); })
      .catch((problem) => { if (active) setError(problem instanceof Error ? problem.message : "Unable to read canonical Food orders"); });
    return () => { active = false; };
  }, [workspace]);
  return <main style={{ maxWidth: 900, margin: "0 auto", padding: 28, fontFamily: "system-ui", display: "grid", gap: 14 }}>
    <header><Link href="/team/operations/food">← Food Operations queue</Link><h1>{title}</h1><p>Pick the canonical Food order to work on.</p></header>
    {error && <p role="alert">{error}</p>}
    {!choices && !error && <p>Reading canonical Food orders…</p>}
    {choices && !choices.length && <p>No canonical Food order exists yet. One appears here as soon as a Food order is created.</p>}
    {choices?.map((choice) => <Link key={choice.id} href={choice.href} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14, display: "block" }}>
      <strong>{choice.id}</strong>
      <div>{choice.label.slice(choice.id.length + 3)}</div>
      <small>{choice.flags.length ? choice.flags.map((flag) => flag.replaceAll("_", " ")).join(" · ") : "Clear"}</small>
    </Link>)}
  </main>;
}
