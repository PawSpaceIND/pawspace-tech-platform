const paths: Record<string, React.ReactNode> = {
  grooming: <><circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="m9 8 12 12M9 16 21 4"/></>,
  boarding: <><path d="m3 11 9-8 9 8v10H3V11Z"/><path d="M9 21v-8h6v8"/></>,
  dog_training: <><path d="m4 9 3-6 5 3 5-3 3 6-2 12H6L4 9Z"/><path d="M9 11h.01M15 11h.01m-5 5 2 2 2-2"/></>,
  pet_sitting: <><path d="M12 20s-9-5-9-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6-9 11-9 11Z"/></>,
  dog_walking: <><path d="M14 5a4 4 0 1 1 5 5l-3 1-5 8a4 4 0 0 1-7-4l2-3 4 2"/><path d="m10 14 5-8"/></>,
  food: <><path d="M3 12h18a9 9 0 0 1-18 0ZM6 21h12M8 8V4m4 4V2m4 6V4"/></>,
  relocation: <><rect x="5" y="6" width="14" height="15" rx="2"/><path d="M9 6V3h6v3m-6 5v5m6-5v5M3 10h2m14 0h2"/></>,
  pet_taxi: <><path d="m4 10 2-6h12l2 6v9H4v-9Zm0 0h16M7 14h.01M17 14h.01M7 19v2m10-2v2"/></>,
};
export default function ServiceIcon({code}: {code:string}) {
  return <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[code]}</svg>;
}
