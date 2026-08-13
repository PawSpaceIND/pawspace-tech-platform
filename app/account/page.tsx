import { redirect } from "next/navigation";

/**
 * RETIRED ROUTE — this was a customer-facing prototype that showed a signed-in person INVENTED data
 * about themselves: a fixed customer name and join year, an invented care score, an eight-row
 * service history, a wallet with sessions remaining and a payment history — none of it from the
 * database. It was linked from the home page and the marketing site, so a real customer could read
 * fabricated spend and bookings as their own.
 *
 * The real customer account already exists inside the app (app/mobile-app/customer-account-view.tsx,
 * fed by /api/customer-account), reachable from the app's bottom navigation. This route now sends
 * people there instead of to a mock.
 */
export default function RetiredAccountPage() {
  redirect("/mobile-app");
}
