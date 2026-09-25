const paths: Record<string, string> = {
  grooming: "M4 4l16 16M20 4L4 20M8 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  boarding: "M3 11l9-8 9 8M5 10v11h14V10M9 21v-7h6v7",
  dog_training: "M9 4h6v3H9zM8 5H5v16h14V5h-3M8 13l3 3 5-6",
  pet_sitting: "M20 9c0 5-8 11-8 11S4 14 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1Z",
  dog_walking: "M7 4v7a4 4 0 0 0 4 4h3M14 10v10M10 20h8M3 3h8M18 4h3v8h-3z",
  food: "M3 10h18l-2 10H5L3 10ZM7 3v3M12 2v4M17 3v3",
  relocation: "M4 7h16v14H4zM8 7V3h8v4M12 10v8M9 13l3-3 3 3",
  pet_taxi: "M5 8l2-5h10l2 5M3 8h18v10H3zM6 12h1M17 12h1M5 18v3M19 18v3",
};
/** Decorative, monochrome service mark. Availability and routing belong to the card. */
export default function V2ServiceIcon({ code }: { code: string }) {
  return <svg aria-hidden="true" focusable="false" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[code] ?? paths.pet_sitting} /></svg>;
}
