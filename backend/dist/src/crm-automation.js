import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { enqueueNotification } from "./notifications.js";
const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const now = () => new Date().toISOString();
const phoneHash = (phone) => createHash("sha256").update(phone.replace(/\D/g, "").slice(-10)).digest("hex");
const pepper = () => process.env.OTP_PEPPER ?? "development-only-otp-pepper";
const codeHash = (challengeId, code) => createHmac("sha256", pepper()).update(`${challengeId}:${code}`).digest();
export async function requestOtp(repository, phone, purpose) {
    const hashed = phoneHash(phone);
    const recent = (await repository.listOtpChallenges(hashed)).filter(x => Date.now() - new Date(x.createdAt).getTime() < 10 * 60_000);
    if (recent.length >= 3)
        throw Object.assign(new Error("Too many OTP requests. Try again after 10 minutes"), { statusCode: 429 });
    const code = String(randomInt(100000, 1000000));
    const challengeId = id("otp");
    const timestamp = now();
    const challenge = { id: challengeId, phoneHash: hashed, purpose, codeHash: codeHash(challengeId, code).toString("hex"), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), attempts: 0, maxAttempts: 5, createdAt: timestamp };
    await repository.createOtpChallenge(challenge);
    await enqueueNotification(repository, { eventType: "otp.requested", channels: ["sms"], templateCode: "secure_otp", payload: { phoneHash: hashed.slice(0, 12), challengeId, purpose } });
    return { challengeId, expiresAt: challenge.expiresAt, developmentCode: process.env.NODE_ENV === "production" ? undefined : code };
}
export async function verifyOtp(repository, challengeId, code) {
    const challenge = await repository.getOtpChallenge(challengeId);
    if (!challenge)
        throw Object.assign(new Error("OTP challenge not found"), { statusCode: 404 });
    if (challenge.consumedAt)
        throw Object.assign(new Error("OTP already used"), { statusCode: 409 });
    if (new Date(challenge.expiresAt) < new Date())
        throw Object.assign(new Error("OTP expired"), { statusCode: 410 });
    if (challenge.attempts >= challenge.maxAttempts)
        throw Object.assign(new Error("OTP attempts exceeded"), { statusCode: 429 });
    const expected = Buffer.from(challenge.codeHash, "hex"), actual = codeHash(challenge.id, code);
    const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!valid) {
        await repository.updateOtpChallenge(challenge.id, { attempts: challenge.attempts + 1 });
        throw Object.assign(new Error("Incorrect OTP"), { statusCode: 401 });
    }
    await repository.updateOtpChallenge(challenge.id, { attempts: challenge.attempts + 1, consumedAt: now() });
    return { verified: true, purpose: challenge.purpose };
}
export function defaultPreference(customerId) { return { customerId, serviceUpdates: true, reminders: true, marketing: false, channels: ["push", "whatsapp"], quietHoursStart: "21:00", quietHoursEnd: "09:00", reminderCadence: "every_15_days", updatedAt: now() }; }
export async function enrollJourney(repository, input) {
    const timestamp = now();
    const enrollment = { id: id("journey"), customerId: input.customerId, journeyCode: input.journeyCode, status: "active", nextRunAt: input.nextRunAt, metadata: input.metadata ?? {}, createdAt: timestamp, updatedAt: timestamp };
    return repository.createEnrollment(enrollment);
}
const templates = { care_15_day: { eventType: "care.reminder", templateCode: "care_due_15_day" }, subscription_renewal: { eventType: "subscription.renewal_due", templateCode: "subscription_renewal" }, payment_recovery: { eventType: "payment.pending", templateCode: "payment_reminder" }, service_recovery: { eventType: "service.recovery", templateCode: "service_recovery" }, app_adoption: { eventType: "app.adoption", templateCode: "download_app" } };
export async function runJourney(repository, enrollment, runAt = now()) {
    const preference = await repository.getCommunicationPreference(enrollment.customerId) ?? defaultPreference(enrollment.customerId);
    const marketingJourney = enrollment.journeyCode === "app_adoption";
    if ((marketingJourney && !preference.marketing) || (!marketingJourney && !preference.serviceUpdates)) {
        await repository.updateEnrollment(enrollment.id, { status: "suppressed", lastRunAt: runAt, updatedAt: runAt });
        return { status: "suppressed", reason: "customer_preference" };
    }
    const template = templates[enrollment.journeyCode];
    const channels = preference.channels.length ? preference.channels : ["push"];
    const notification = await enqueueNotification(repository, { eventType: template.eventType, customerId: enrollment.customerId, channels, templateCode: template.templateCode, payload: { ...enrollment.metadata, journeyId: enrollment.id } });
    let ticket;
    if (enrollment.journeyCode === "service_recovery") {
        ticket = { id: id("ticket"), customerId: enrollment.customerId, bookingId: String(enrollment.metadata.bookingId ?? "") || undefined, category: "service_recovery", priority: "high", status: "open", source: "automation", summary: String(enrollment.metadata.summary ?? "Automated service-recovery follow-up"), assignedTeam: "Customer Experience", slaDueAt: new Date(new Date(runAt).getTime() + 30 * 60_000).toISOString(), createdAt: runAt, updatedAt: runAt };
        await repository.createTicket(ticket);
    }
    const recurring = enrollment.journeyCode === "care_15_day";
    await repository.updateEnrollment(enrollment.id, { status: recurring ? "active" : "completed", lastRunAt: runAt, nextRunAt: recurring ? new Date(new Date(runAt).getTime() + 15 * 24 * 60 * 60 * 1000).toISOString() : enrollment.nextRunAt, updatedAt: runAt });
    return { status: "queued", notificationId: notification.id, ticketId: ticket?.id };
}
export async function runDueJourneys(repository, asOf = now()) {
    const due = (await repository.listEnrollments("active")).filter(x => new Date(x.nextRunAt) <= new Date(asOf));
    const results = [];
    for (const enrollment of due)
        results.push({ enrollmentId: enrollment.id, ...await runJourney(repository, enrollment, asOf) });
    return { evaluated: due.length, results };
}
