// Live checks for fixes that the money suites do not already prove, run after 05/06 in the same run:
//  - Grooming copy: the V2 catalogue shows what a package includes, never the seed note ("Canonical …").
//  - PARTNER-01: the Boarding host sees the pets and the care plan of the split stay booked by 06, with the
//    emergency contact and vet withheld until the host accepts.
//  - PARTNER-03: the driver of the Pet Taxi ride booked by 06 (weeks ahead) cannot confirm the pickup handover.
// Everything touches only this run's own synthetic bookings. The taxi ride is left accepted with its reserved car.
import { launch, newFlow, api, customerSession, providerSession, readBookings, record, finding, writeJson, runPhone } from "../lib.mjs";

const SUITE = "08-fix-verification";
const out = { suite: SUITE };
const browser = await launch();
try {
  // Grooming copy.
  const cus = await newFlow(browser, "08-grooming-copy");
  try {
    await customerSession(cus.context, "customer-b");
    const cat = await api(cus.context, "GET", "/api/v2/grooming-catalogue");
    const packages = cat.body?.data?.packages || [];
    const seeded = packages.filter(item => /canonical/i.test(String(item.description || "")));
    out.grooming = { status: cat.status, count: packages.length, descriptions: packages.map(item => `${item.code}: ${String(item.description || "").slice(0, 90)}`) };
    record({ suite: SUITE, journey: "V2 grooming catalogue copy", combo: `${packages.length} packages`, result: cat.status === 200 && packages.length && !seeded.length ? "PASS" : "FAIL", detail: JSON.stringify(out.grooming.descriptions.slice(0, 4)), evidence: [] });
  } catch (e) { record({ suite: SUITE, journey: "V2 grooming catalogue copy", combo: "customer view", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await cus.close();

  // PARTNER-01: host view of 06's split stay.
  const stay = readBookings(row => row.suite === "06-money-and-maps" && row.service === "boarding").at(-1);
  const host = await newFlow(browser, "08-host-care-plan");
  try {
    if (!stay?.bookingId || !stay?.providerId) throw new Error("no Boarding stay from 06 in this run");
    await providerSession(host.context, stay.providerId);
    const r = await api(host.context, "GET", `/api/boarding-stays?bookingId=${encodeURIComponent(stay.bookingId)}`);
    const row = (r.body?.data || [])[0];
    const plan = row?.carePlan?.plan || {}, withheld = row?.carePlan?.withheldUntilAccepted || [];
    out.host = { status: r.status, bookingStatus: row?.status, pets: row?.pets, plan, withheld };
    const petsShown = Array.isArray(row?.pets) && row.pets.some(pet => pet?.name);
    const contactsHeld = !plan.emergencyContact && !plan.vet && withheld.includes("emergencyContact") && withheld.includes("vet");
    record({ suite: SUITE, journey: "Host sees pets and care plan (PARTNER-01)", combo: `${stay.bookingId} before acceptance`, result: r.status === 200 && petsShown && plan.feeding && contactsHeld ? "PASS" : "FAIL", detail: JSON.stringify(out.host).slice(0, 600), evidence: [] });
  } catch (e) { record({ suite: SUITE, journey: "Host sees pets and care plan (PARTNER-01)", combo: "06 split stay", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await host.close();

  // PARTNER-03: early pickup refused for 06's ride.
  const ride = readBookings(row => row.suite === "06-money-and-maps" && row.service === "pet_taxi" && row.paid).at(-1);
  const driver = await newFlow(browser, "08-taxi-early-pickup");
  try {
    if (!ride?.bookingId || !ride?.providerId) throw new Error("no paid Pet Taxi ride from 06 in this run");
    await providerSession(driver.context, ride.providerId);
    const act = (action, extra = {}) => api(driver.context, "POST", "/api/taxi-lifecycle", { bookingId: ride.bookingId, action, idempotencyKey: `verify-${action}-${runPhone(8)}`, ...extra });
    const accepted = await act("accept");
    const assigned = await act("assign_vehicle");
    const pickup = await act("confirm_pickup", { handoverMethod: "owner" });
    out.taxi = { bookingId: ride.bookingId, scheduledStart: ride.scheduledStart, accept: accepted.status, assign: assigned.status, pickup: { status: pickup.status, body: pickup.body } };
    const refusedEarly = pickup.status === 409 && pickup.body?.code === "taxi_pickup_too_early";
    record({ suite: SUITE, journey: "Taxi pickup cannot be confirmed early (PARTNER-03)", combo: `${ride.bookingId}, pickup ${ride.scheduledStart}`, result: refusedEarly ? "PASS" : (accepted.status < 300 && assigned.status < 300 ? "FAIL" : "BLOCKED"), detail: JSON.stringify(out.taxi).slice(0, 600), evidence: [] });
    if (!refusedEarly && pickup.status < 300) finding({ suite: SUITE, severity: "P1", area: "Pet Taxi driver lifecycle", persona: "Driver", flow: "Pickup handover", title: "A Pet Taxi pickup booked weeks ahead can still be confirmed now", steps: `Accept, assign vehicle, confirm_pickup for ${ride.bookingId}`, expected: "409 taxi_pickup_too_early", actual: JSON.stringify(pickup.body).slice(0, 300), evidence: [] });
  } catch (e) { record({ suite: SUITE, journey: "Taxi pickup cannot be confirmed early (PARTNER-03)", combo: "06 ride", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await driver.close();
} finally {
  writeJson("fix-verification.json", out);
  await browser.close();
}
