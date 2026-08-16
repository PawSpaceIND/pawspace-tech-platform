"use client";
import { useEffect, useMemo, useState } from "react";
import styles from "./food-flow.module.css";
import type { LoggedInCustomer } from "./customer-login";
import PetManager from "./pet-manager";
import { loadCustomerPets, type CustomerPet } from "../../lib/customer-account-client";
import {
  loadFoodCatalogue,
  quoteFoodCart,
  placeQuotedFoodOrders,
  type FoodCatalogueItem,
  type FoodCartLine,
  type FoodOrderResult,
  type FoodQuote,
} from "../../lib/food-client";
import { createFoodSubscription } from "../../lib/food-subscription-client";

// Species drives per-pet food suggestions; the pets are the customer's own, loaded at runtime.
const petIcon = (species: string) => (species === "cat" ? "🐈" : species === "dog" ? "🐕" : "🐾");
const petDetail = (pet: CustomerPet) =>
  [pet.profile?.breed || pet.breed, pet.profile?.ageBand, pet.profile?.weightBand].filter(Boolean).join(" · ") ||
  "Profiles, health notes and service history included";

// Customer-selected renewal cadence. The Food subscription API accepts any explicit
// 7-90 day interval (see /api/food-subscriptions), so every option below is server-valid.
const repeatPlans = [
  { intervalDays: 7, label: "Weekly", note: "Every 7 days" },
  { intervalDays: 14, label: "Fortnightly", note: "Every 14 days" },
  { intervalDays: 30, label: "Monthly", note: "Every 30 days" },
];

const deliveryWindows = ["Morning · 9 AM–12 PM", "Afternoon · 12–4 PM", "Evening · 4–8 PM"];

const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const lineName = (item: FoodCatalogueItem) => item.name.split("·")[0].trim();
const speciesIcon = (species: string) => (species === "cat" ? "🐈" : "🐕");
const renewalDate = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

type SubscriptionCreated = { subscriptionId: string; nextRenewalAt: number; renewalIntervalDays: number; sourceOrderId: string };

export default function FoodFlow({ customer, onCompleted }: { customer: LoggedInCustomer; onCompleted?: (orderIds: string[]) => void }) {
  const [step, setStep] = useState(1);
  const [catalogue, setCatalogue] = useState<FoodCatalogueItem[]>([]);
  const [catalogueError, setCatalogueError] = useState("");
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [selectedPets, setSelectedPets] = useState<string[]>([]);
  const [pets, setPets] = useState<CustomerPet[]>([]);
  const [petsLoading, setPetsLoading] = useState(true);
  const [petsError, setPetsError] = useState("");
  const [showPetManager, setShowPetManager] = useState(false);
  const [cart, setCart] = useState<FoodCartLine[]>([]);
  const [plan, setPlan] = useState<"one_time" | "repeat">("one_time");
  const [intervalDays, setIntervalDays] = useState(repeatPlans[2].intervalDays);
  const [address, setAddress] = useState("");
  const [pincode, setPincode] = useState("");
  const [window_, setWindow] = useState(deliveryWindows[0]);
  const [quotes, setQuotes] = useState<FoodQuote[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [quoting, setQuoting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [flowError, setFlowError] = useState("");
  const [orders, setOrders] = useState<FoodOrderResult[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionCreated[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    loadFoodCatalogue("blr-east")
      .then((data) => {
        if (!active) return;
        setCatalogue(data.items);
        setCatalogueError("");
      })
      .catch((error) => {
        if (active) setCatalogueError(error instanceof Error ? error.message : "Unable to load the Food catalogue");
      })
      .finally(() => {
        if (active) setCatalogueLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setPetsLoading(true);
    loadCustomerPets(customer.customerId)
      .then((loaded) => {
        if (!active) return;
        setPets(loaded);
        setSelectedPets((prev) => {
          const kept = prev.filter((id) => loaded.some((p) => p.id === id));
          return kept.length ? kept : loaded[0] ? [loaded[0].id] : [];
        });
        setPetsError("");
      })
      .catch((e) => { if (active) setPetsError(e instanceof Error ? e.message : "Unable to load your pets"); })
      .finally(() => { if (active) setPetsLoading(false); });
    return () => { active = false; };
  }, [customer.customerId]);
  const onPetsChanged = (updated: CustomerPet[]) => {
    setPets(updated);
    setSelectedPets((prev) => {
      const kept = prev.filter((id) => updated.some((p) => p.id === id));
      return kept.length ? kept : updated[0] ? [updated[0].id] : [];
    });
  };
  const selectedSpecies = useMemo(() => new Set(pets.filter((pet) => selectedPets.includes(pet.id)).map((pet) => pet.species)), [pets, selectedPets]);
  const grouped = useMemo(() => {
    const bySpecies: Record<string, FoodCatalogueItem[]> = {};
    for (const item of catalogue) (bySpecies[item.pet_type] ||= []).push(item);
    return Object.entries(bySpecies).sort(([a], [b]) => {
      const aMatch = selectedSpecies.has(a as "dog" | "cat") ? 0 : 1;
      const bMatch = selectedSpecies.has(b as "dog" | "cat") ? 0 : 1;
      return aMatch - bMatch || a.localeCompare(b);
    });
  }, [catalogue, selectedSpecies]);

  const itemBySku = useMemo(() => new Map(catalogue.map((item) => [item.sku, item])), [catalogue]);
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const indicativeTotal = cart.reduce((sum, line) => sum + (itemBySku.get(line.sku)?.unit_price ?? 0) * line.quantity, 0);
  const suggestedFor = (item: FoodCatalogueItem) => pets.filter((pet) => selectedPets.includes(pet.id) && pet.species === item.pet_type).map((pet) => pet.name);

  const togglePet = (id: string) => setSelectedPets((current) => (current.includes(id) ? current.filter((pet) => pet !== id) : [...current, id]));
  const qtyOf = (sku: string) => cart.find((line) => line.sku === sku)?.quantity ?? 0;
  const setQty = (item: FoodCatalogueItem, quantity: number) => {
    const capped = Math.max(0, Math.min(quantity, item.max_qty_per_order, item.uat_available_units));
    setCart((current) => {
      const rest = current.filter((line) => line.sku !== item.sku);
      return capped > 0 ? [...rest, { sku: item.sku, quantity: capped }] : rest;
    });
  };

  const reviewOrder = async () => {
    setQuoting(true);
    setFlowError("");
    try {
      const result = await quoteFoodCart(cart, "blr-east");
      setQuotes(result.quotes);
      setServerTotal(result.serverTotal);
      setStep(5);
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : "Unable to get a server quote");
    } finally {
      setQuoting(false);
    }
  };

  const confirm = async () => {
    setConfirming(true);
    setFlowError("");
    try {
      const created = await placeQuotedFoodOrders({
        quotes,
        customer: { id: customer.customerId, name: customer.customerName, primaryPhone: customer.phone },
        cityId: "blr",
        zoneId: "blr-east",
      });
      const subs: SubscriptionCreated[] = [];
      if (plan === "repeat") {
        for (const order of created) {
          const result = (await createFoodSubscription({ sourceOrderId: order.orderId, renewalIntervalDays: intervalDays, communicationChannel: "whatsapp" })) as Record<string, unknown>;
          subs.push({ subscriptionId: String(result.subscriptionId), nextRenewalAt: Number(result.nextRenewalAt), renewalIntervalDays: intervalDays, sourceOrderId: order.orderId });
        }
      }
      setOrders(created);
      setSubscriptions(subs);
      setDone(true);
      onCompleted?.(created.map((order) => order.orderId));
    } catch (error) {
      setFlowError(error instanceof Error ? error.message : "Unable to place the Food order");
    } finally {
      setConfirming(false);
    }
  };

  if (done)
    return (
      <section className={styles.flow}>
        <article className={styles.success}>
          <i>✓</i>
          <small>FOOD ORDER CONFIRMED</small>
          <h3>{orders.length === 1 ? "Your order is reserved." : `${orders.length} orders are reserved.`}</h3>
          <p>
            {cartCount} item{cartCount > 1 ? "s" : ""} · {money(serverTotal)} · pay on delivery (UAT sandbox)
          </p>
        </article>
        {orders.map((order, index) => {
          const quote = quotes[index]; // placeQuotedFoodOrders creates one order per quote, in order
          const subscription = subscriptions.find((sub) => sub.sourceOrderId === order.orderId);
          return (
            <article key={order.orderId} className={styles.orderCard}>
              <header>
                <b>{order.orderId}</b>
                <em>{money(order.totalAmount)}</em>
              </header>
              {quote && (
                <p>
                  {quote.name} × {quote.quantity}
                </p>
              )}
              <small>
                Delivery: {window_} · {address ? `${address}, ` : ""}
                {pincode || "Bengaluru"} · fulfilment team confirms dispatch
              </small>
              {subscription && (
                <span className={styles.subBadge}>
                  Repeats every {subscription.renewalIntervalDays} days · next renewal {renewalDate(subscription.nextRenewalAt)} · no auto-charge, you approve each renewal
                </span>
              )}
            </article>
          );
        })}
        <p className={styles.hint}>Order updates go to {customer.customerName} · {customer.phone}. Track fulfilment from My PawSpace → Orders.</p>
      </section>
    );

  return (
    <section className={styles.flow}>
      <div className={styles.steps}>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={step >= n ? styles.active : ""}>
            {n}
          </span>
        ))}
      </div>

      {step === 1 && (
        <>
          <div className={styles.head}>
            <h3>Fresh food for your pets</h3>
            <small>CATALOGUE · 1 OF 5</small>
          </div>
          <div className={styles.petRow}>
            {petsLoading && <p className={styles.hint}>Loading your pets…</p>}
            {petsError && <p className={styles.hint} role="alert">{petsError}</p>}
            {!petsLoading && !petsError && pets.length === 0 && <p className={styles.hint}>No pets on your profile yet — add one below for tailored food picks.</p>}
            {pets.map((pet) => (
              <button key={pet.id} className={selectedPets.includes(pet.id) ? styles.selected : ""} onClick={() => togglePet(pet.id)}>
                <i>{petIcon(pet.species)}</i>
                <b>{pet.name}</b>
                <small>{petDetail(pet)}</small>
              </button>
            ))}
            <button onClick={() => setShowPetManager((v) => !v)}>
              <i>{showPetManager ? "−" : "＋"}</i>
              <b>{showPetManager ? "Hide" : "Add pet"}</b>
            </button>
          </div>
          {showPetManager && <PetManager customer={customer} onPetsChanged={onPetsChanged} />}
          {catalogueLoading && <p className={styles.hint}>Loading the live catalogue…</p>}
          {catalogueError && <p role="alert" className={styles.error}>{catalogueError}</p>}
          {grouped.map(([species, items]) => (
            <div key={species}>
              <div className={styles.section}>
                <b>
                  {speciesIcon(species)} {species === "dog" ? "Dog food" : species === "cat" ? "Cat food" : `${species} food`}
                </b>
                <span>{selectedSpecies.has(species as "dog" | "cat") ? "MATCHES YOUR PETS" : "OTHER PETS"}</span>
              </div>
              {items.map((item) => {
                const names = suggestedFor(item);
                return (
                  <article key={item.sku} className={styles.item}>
                    <div>
                      <b>{lineName(item)}</b>
                      <small>
                        {item.pack_size} · {item.uat_available_units} in stock
                      </small>
                      {names.length > 0 && <span className={styles.forPets}>Suggested for {names.join(" & ")}</span>}
                    </div>
                    <div className={styles.itemBuy}>
                      <em>{money(item.unit_price)}</em>
                      {qtyOf(item.sku) === 0 ? (
                        <button className={styles.addBtn} disabled={item.uat_available_units < 1} onClick={() => setQty(item, 1)}>
                          {item.uat_available_units < 1 ? "Out of stock" : "Add"}
                        </button>
                      ) : (
                        <span className={styles.stepper}>
                          <button onClick={() => setQty(item, qtyOf(item.sku) - 1)}>−</button>
                          <b>{qtyOf(item.sku)}</b>
                          <button onClick={() => setQty(item, qtyOf(item.sku) + 1)}>＋</button>
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ))}
          <button className={styles.primary} disabled={cart.length === 0} onClick={() => setStep(2)}>
            {cart.length === 0 ? "Add food to continue" : `Review cart · ${cartCount} item${cartCount > 1 ? "s" : ""}`}
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <div className={styles.head}>
            <h3>Your cart</h3>
            <small>CART · 2 OF 5</small>
          </div>
          {cart.map((line) => {
            const item = itemBySku.get(line.sku);
            if (!item) return null;
            return (
              <article key={line.sku} className={styles.item}>
                <div>
                  <b>{lineName(item)}</b>
                  <small>
                    {item.pack_size} · {money(item.unit_price)} each · max {item.max_qty_per_order}/order
                  </small>
                </div>
                <div className={styles.itemBuy}>
                  <em>{money(item.unit_price * line.quantity)}</em>
                  <span className={styles.stepper}>
                    <button onClick={() => setQty(item, line.quantity - 1)}>−</button>
                    <b>{line.quantity}</b>
                    <button onClick={() => setQty(item, line.quantity + 1)}>＋</button>
                  </span>
                </div>
              </article>
            );
          })}
          <article className={styles.totalRow}>
            <span>
              Indicative total
              <b>{money(indicativeTotal)}</b>
            </span>
            <small>Final prices are server-quoted at review — the app never computes what you pay.</small>
          </article>
          <button className={styles.back} onClick={() => setStep(1)}>
            ← Catalogue
          </button>
          <button className={styles.primary} disabled={cart.length === 0} onClick={() => setStep(3)}>
            Choose delivery plan
          </button>
        </>
      )}

      {step === 3 && (
        <>
          <div className={styles.head}>
            <h3>One-time or repeat?</h3>
            <small>PLAN · 3 OF 5</small>
          </div>
          <div className={styles.planRow}>
            <button className={plan === "one_time" ? styles.selected : ""} onClick={() => setPlan("one_time")}>
              <b>One-time order</b>
              <span>A single delivery of this cart</span>
            </button>
            <button className={plan === "repeat" ? styles.selected : ""} onClick={() => setPlan("repeat")}>
              <b>Repeat delivery</b>
              <span>Same cart, on your schedule</span>
            </button>
          </div>
          {plan === "repeat" && (
            <>
              <div className={styles.section}>
                <b>How often?</b>
                <span>YOU APPROVE EVERY RENEWAL</span>
              </div>
              <div className={styles.planRow}>
                {repeatPlans.map((option) => (
                  <button key={option.intervalDays} className={intervalDays === option.intervalDays ? styles.selected : ""} onClick={() => setIntervalDays(option.intervalDays)}>
                    <b>{option.label}</b>
                    <span>{option.note}</span>
                  </button>
                ))}
              </div>
              <p className={styles.hint}>No auto-charge: before each renewal you get a WhatsApp reminder and pay only after approving it.</p>
            </>
          )}
          <button className={styles.back} onClick={() => setStep(2)}>
            ← Cart
          </button>
          <button className={styles.primary} onClick={() => setStep(4)}>
            Delivery details
          </button>
        </>
      )}

      {step === 4 && (
        <>
          <div className={styles.head}>
            <h3>Where and when?</h3>
            <small>DELIVERY · 4 OF 5</small>
          </div>
          <label className={styles.field}>
            Delivery address
            <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="House, street, area" />
          </label>
          <label className={styles.field}>
            Pincode
            <input value={pincode} inputMode="numeric" maxLength={6} onChange={(event) => setPincode(event.target.value.replace(/\D/g, ""))} placeholder="560038" />
          </label>
          <div className={styles.section}>
            <b>Preferred delivery window</b>
            <span>BENGALURU EAST ZONE</span>
          </div>
          <div className={styles.planRow}>
            {deliveryWindows.map((option) => (
              <button key={option} className={window_ === option ? styles.selected : ""} onClick={() => setWindow(option)}>
                <b>{option.split("·")[0].trim()}</b>
                <span>{option.split("·")[1].trim()}</span>
              </button>
            ))}
          </div>
          <p className={styles.hint}>UAT sandbox: the fulfilment team confirms dispatch against the Bengaluru-East inventory zone; your address and window guide the delivery run.</p>
          <button className={styles.back} onClick={() => setStep(3)}>
            ← Plan
          </button>
          <button className={styles.primary} disabled={quoting || !address.trim() || pincode.length !== 6} onClick={() => void reviewOrder()}>
            {quoting ? "Getting server quote…" : "Review with server quote"}
          </button>
          {flowError && <p role="alert" className={styles.error}>{flowError}</p>}
        </>
      )}

      {step === 5 && (
        <>
          <div className={styles.head}>
            <h3>Review and confirm</h3>
            <small>CONFIRM · 5 OF 5</small>
          </div>
          {quotes.map((quote) => (
            <article key={quote.quoteId} className={styles.item}>
              <div>
                <b>{quote.name}</b>
                <small>
                  {quote.packSize} × {quote.quantity} · server quote {quote.quoteId}
                </small>
              </div>
              <em>{money(quote.totalAmount)}</em>
            </article>
          ))}
          <article className={styles.review}>
            <span>
              Delivery
              <b>
                {address}, {pincode} · {window_}
              </b>
            </span>
            <span>
              Plan
              <b>{plan === "one_time" ? "One-time delivery" : `${repeatPlans.find((option) => option.intervalDays === intervalDays)?.label} repeat · you approve each renewal`}</b>
            </span>
            <span>
              Contact
              <b>
                {customer.customerName} · {customer.phone}
              </b>
            </span>
          </article>
          <article className={styles.totalRow}>
            <span>
              Server-quoted total
              <b>{money(serverTotal)}</b>
            </span>
            <small>Free delivery in UAT · ₹0 due now, pay on delivery (sandbox) · quotes valid 15 minutes.</small>
          </article>
          <button className={styles.back} onClick={() => setStep(4)}>
            ← Delivery
          </button>
          <button className={styles.primary} disabled={confirming} onClick={() => void confirm()}>
            {confirming ? "Placing order…" : plan === "repeat" ? "Confirm order + repeat plan" : "Confirm food order"}
          </button>
          {flowError && <p role="alert" className={styles.error}>{flowError}</p>}
        </>
      )}
    </section>
  );
}
