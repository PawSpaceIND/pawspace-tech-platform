import { serviceAddressPincodes } from "./service-address-pincode";
/** A contradiction check, not a geocoder. A matching PIN never proves a doorstep. */
const CITY_ALIASES = [
  ["bengaluru", "bangalore"], ["mumbai", "bombay"], ["chennai", "madras"],
  ["delhi", "new delhi"], ["hyderabad"], ["pune"], ["kolkata", "calcutta"],
];
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionsLocality = (address: string, name: string) =>
  new RegExp(`\\b${escape(name)}\\b(?!\\s+(?:road|street|lane|avenue|apartments?|building|cafe|restaurant|hotel|bank|store|bakery)\\b)`, "i").test(address);
export function serviceAddressConflict(address: string, city: string, pincode: string): string | null {
  if (address.length > 2000) return "Keep the complete service address within 2,000 characters.";
  const pins = serviceAddressPincodes(address);
  if (pins.some(pin => pin !== pincode)) return "The address and selected PIN code do not match. Correct the address before continuing.";
  const expected = city.trim().toLowerCase();
  const expectedAliases = CITY_ALIASES.find(names => names.includes(expected)) || [expected];
  for (const aliases of CITY_ALIASES) {
    if (aliases.some(name => expectedAliases.includes(name))) continue;
    if (aliases.some(name => mentionsLocality(address, name)))
      return `The address names a different city from ${city}. Correct the city and PIN code before continuing.`;
  }
  // Parse delimited components once. Do not search repeated whitespace with a backtracking regex.
  const otherStates = new Set(["maharashtra", "tamil nadu", "telangana", "kerala", "gujarat", "west bengal", "uttar pradesh", "haryana", "rajasthan"]);
  if (expectedAliases.includes("bengaluru")) for (const component of address.split(/[,;\n]/)) {
    const words = component.trim().toLowerCase().split(/\s+/);
    if (words.at(-1) === "india") words.pop();
    if (/^[0-9]{6}$/.test(words.at(-1) || "")) words.pop();
    if (otherStates.has(words.join(" ")))
      return "The address state does not match the Bengaluru service area. Correct the state and PIN code before continuing.";
  }
  return null;
}
