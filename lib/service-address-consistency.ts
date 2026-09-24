/** A contradiction check, not a geocoder. A matching PIN never proves a doorstep. */
const CITY_ALIASES = [
  ["bengaluru", "bangalore"], ["mumbai", "bombay"], ["chennai", "madras"],
  ["delhi", "new delhi"], ["hyderabad"], ["pune"], ["kolkata", "calcutta"],
];
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionsLocality = (address: string, name: string) =>
  new RegExp(`\\b${escape(name)}\\b(?!\\s+(?:road|street|lane|avenue|apartments?|building|cafe|restaurant|hotel|bank|store|bakery)\\b)`, "i").test(address);
export function serviceAddressConflict(address: string, city: string, pincode: string): string | null {
  const pins = address.match(/\b\d{6}\b/g) || [];
  if (pins.some(pin => pin !== pincode)) return "The address and selected PIN code do not match. Correct the address before continuing.";
  const expected = city.trim().toLowerCase();
  const expectedAliases = CITY_ALIASES.find(names => names.includes(expected)) || [expected];
  for (const aliases of CITY_ALIASES) {
    if (aliases.some(name => expectedAliases.includes(name))) continue;
    if (aliases.some(name => mentionsLocality(address, name)))
      return `The address names a different city from ${city}. Correct the city and PIN code before continuing.`;
  }
  // State names must be address components, not a landmark such as Bank of Maharashtra.
  if (expectedAliases.includes("bengaluru") && /(?:^|[,;\n])\s*(?:maharashtra|tamil nadu|telangana|kerala|gujarat|west bengal|uttar pradesh|haryana|rajasthan)(?:\s+\d{6})?(?:\s+india)?\s*(?=$|[,;\n])/i.test(address))
    return "The address state does not match the Bengaluru service area. Correct the state and PIN code before continuing.";
  return null;
}
