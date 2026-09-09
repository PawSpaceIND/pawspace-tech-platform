"use client";

import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";
import { searchAddresses, type AddressSuggestion } from "../../lib/address-autocomplete-client";

/** Suggestions are convenience only; booking still verifies coordinates and coverage. */
export default function AddressAutofill({ value, onChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const token = useRef("");
  const [options, setOptions] = useState<AddressSuggestion[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    setOptions([]); setUnavailable(false);
    if (value.trim().length < 3) return;
    const timer = setTimeout(() => {
      token.current ||= crypto.randomUUID();
      void searchAddresses(value.trim(), token.current).then(result => {
        if (!active) return;
        setOptions(result.status === "configured" ? result.suggestions : []);
        setUnavailable(result.status !== "configured");
      }).catch(() => { if (active) setUnavailable(true); });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [value]);
  return <><input {...props} value={value} list={id} autoComplete="street-address" onChange={event => onChange(event.target.value)} aria-describedby={unavailable ? `${id}-status` : props["aria-describedby"]} />
    <datalist id={id}>{options.map(option => <option key={option.placeId} value={option.fullText || `${option.mainText}, ${option.secondaryText}`} />)}</datalist>
    {unavailable && <small id={`${id}-status`} role="status">Suggestions are unavailable. You can still enter your address.</small>}
  </>;
}
