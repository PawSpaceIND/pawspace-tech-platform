"use client";
import { useEffect, useRef, useState } from 'react';
import { saveCustomerBoardingCare } from '../../lib/boarding-customer-care';
import { saveSittingCustomerPlan } from '../../lib/sitting-customer-view';
import type { SittingCarePlan } from '../../lib/sitting-lifecycle';
import BookingPaymentPage from './booking-payment-page';
import styles from './booking-payment-page.module.css';

type Props = {
  mode: 'boarding' | 'sitting'; carePlan: SittingCarePlan;
  payment: { bookingId: string; serviceName: string; total: number; dueNow: number; mode: 'prepaid' | 'split_50_50' };
  onVerified: () => void;
};
/** Retrying this boundary only saves care on the SAME booking. It cannot reserve or charge again. */
export default function StayCarePaymentGate({ mode, carePlan, payment, onVerified }: Props) {
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(true);
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const initialPlan = useRef(carePlan);
  useEffect(() => {
    let active = true;
    const save = mode === 'boarding' ? saveCustomerBoardingCare : saveSittingCustomerPlan;
    void save(payment.bookingId, initialPlan.current, `initial-${mode}-care:${payment.bookingId}`)
      .then(() => { if (active) setReady(true); })
      .catch(problem => { if (active) setError(problem instanceof Error ? problem.message : 'Care instructions were not confirmed.'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [mode, payment.bookingId, attempt]);
  if (ready) return <BookingPaymentPage serviceName={payment.serviceName} bookingId={payment.bookingId}
    totalAmount={payment.total} amountDueNow={payment.dueNow} mode={payment.mode} onVerified={onVerified}/>;
  return <section className={styles.page} aria-label="Save stay care before payment">
    <h3>Save care instructions before payment</h3>
    <p>Booking reference: <b>{payment.bookingId}</b>. Your booking has been created, but payment is not confirmed.</p>
    <p>We must confirm your care, vet and emergency instructions before checkout. Do not make another booking.</p>
    {busy && <p role="status">Saving care instructions for this booking…</p>}
    {error && <p role="alert">{error} Your instructions remain here so you can retry the same booking.</p>}
    <button type="button" className={styles.primary} disabled={busy} onClick={() => { setBusy(true); setError(''); setAttempt(value => value + 1); }}>
      {busy ? 'Saving care instructions…' : 'Retry saving care instructions'}
    </button>
  </section>;
}
