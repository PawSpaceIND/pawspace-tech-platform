import { randomUUID } from "node:crypto";
export async function enqueueNotification(repository, input) {
    const timestamp = new Date().toISOString();
    const event = { ...input, id: `notify_${randomUUID().replaceAll("-", "").slice(0, 16)}`, status: "pending", attempts: 0, nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
    return repository.enqueueNotification(event);
}
export async function processNotification(repository, id, deliveredChannels) {
    const pending = (await repository.listNotifications()).find(x => x.id === id);
    if (!pending)
        return null;
    const prior = Array.isArray(pending.payload.deliveredChannels) ? pending.payload.deliveredChannels.filter((x) => typeof x === "string" && pending.channels.includes(x)) : [];
    const delivered = [...new Set([...prior, ...deliveredChannels])];
    const allDelivered = pending.channels.every(channel => delivered.includes(channel));
    const attempts = pending.attempts + 1;
    const retryMinutes = Math.min(60, 2 ** Math.min(attempts, 5));
    return repository.updateNotification(id, { status: allDelivered ? "sent" : delivered.length ? "partially_sent" : "failed", attempts, nextAttemptAt: allDelivered ? new Date().toISOString() : new Date(Date.now() + retryMinutes * 60_000).toISOString(), updatedAt: new Date().toISOString(), payload: { ...pending.payload, deliveredChannels: delivered } });
}
