export const MAYA_AUDIO_SCENARIOS = [
  {
    "id": "complex_grooming",
    "service": "grooming",
    "goal": "Two-pet intake, suitability, corrected pet/address/time, governed offers and truthful booking readiness",
    "turns": [
      "I want grooming for two pets: Bruno is a two-year-old golden retriever and Luna is my new five-month-old kitten. Keep this as a test enquiry; do not create a real booking or send anything.",
      "Bruno needs a haircut and nails, but Luna is anxious and needs only gentle bathing. Compare suitable packages and explain what is not included.",
      "Actually Bruno does not need bathing. Recommend the least expensive suitable package without unnecessary extras, and explain the kitten recommendation separately.",
      "Please use my new kitten Luna, not a saved cat with a similar name. What details are still missing to identify the right pets?",
      "I first said tomorrow morning, but change it to next Tuesday at two PM in Koramangala. Repeat the corrected requested time; availability is not yet confirmed.",
      "The service address is changing from my saved home to an apartment on Double Road in Sudhama Nagar, Bengaluru, PIN five six zero zero two seven. Ask for the remaining exact address details.",
      "Can you give me twenty percent off? If no approved coupon applies, say so. Explain any published repeat-care options without inventing a discount.",
      "Bruno also pulls on his leash. Is there another PawSpace service that would help? Recommend only something useful, and keep grooming as the main enquiry.",
      "Explain the payment options, how a booking becomes confirmed, and how a provider is assigned. This is an explanation only; do not charge or send a payment link.",
      "Give me a final recap with both pets, separate recommendations, corrected address and time, prices you can verify, missing details and what has actually been booked."
    ]
  },
  {
    "id": "complex_taxi",
    "service": "pet_taxi",
    "goal": "Return route corrections, passenger/pet facts, quote boundary and deposit knowledge",
    "turns": [
      "I need a pet taxi enquiry for Bruno from Koramangala to a veterinary clinic in Whitefield. I will travel with him. This is a test; do not book, charge or send messages.",
      "Pickup should be next Monday at eight thirty AM, and we need a return trip. What three or four details should I give you next?",
      "Correct pickup to nine thirty AM. Return pickup from the clinic should be twelve noon. Repeat both corrected times and which address belongs to each leg.",
      "There will be two adult passengers, one dog, and a medium crate. Is that suitable? Do not promise a vehicle or driver until availability is checked.",
      "Pickup is my saved Koramangala home, but I have not given the exact clinic address. Can you quote now, or which route details are still required?",
      "Is there a fixed taxi price? Explain how you get the approved quote. Do not make up a fare because I need an estimate quickly.",
      "Explain the fifty percent upfront payment and remaining payment process, and the Razorpay link steps. Do not send a real link or mark anything paid.",
      "Could I combine the taxi with grooming another day? Recommend a relevant option, but do not confuse the clinic journey with a medical question.",
      "If the driver is unavailable, what happens next? Please distinguish a requested trip from a confirmed booking and tell me when a person must help.",
      "Now recap the return journey, passengers, pet, corrected times, address gaps, payment requirements, and the actual booking state."
    ]
  },
  {
    "id": "complex_funeral",
    "service": "funeral_memorial",
    "goal": "Late collection, freezer, cremation and optional items, exact total/deposit, compassionate intake",
    "turns": [
      "My dog has died and I need help after four PM today in Bengaluru. Explain cremation, burial and wooden cremation sensitively. This is a test enquiry; do not make a real booking or send anything.",
      "Do not assume the pet is Bruno from my account. The pet is Rocky. I want cremation and pickup, and I may not accompany you. Explain whether your team handles everything.",
      "You close cremation at five PM, correct? If pickup is after four PM, explain the overnight freezer and next-day cremation arrangement.",
      "I want ashes delivered to my doorstep. How long does collection take, and what is the extra charge compared with collecting them myself?",
      "What do poojari and ash plantation cost? Explain the options gently and do not add either unless I choose them.",
      "I choose cremation with pickup, doorstep ash delivery and overnight freezer only. No poojari and no ash plantation. Calculate the approved total and the fifty percent deposit.",
      "My primary contact is me and I will provide a secondary contact too. Ask three or four essential pickup and scheduling questions, not every pending detail at once.",
      "If I choose burial instead, what is the base price and who shares the location? Then return to my original cremation choice; do not silently switch the service.",
      "Explain the Razorpay payment link and remaining fifty percent after service, but do not send a real link, charge or confirm payment.",
      "Please recap Rocky, selected items, excluded extras, pickup and ash delivery, next-day plan, verified total and deposit, missing contacts and address, and whether anything is booked."
    ]
  },
  {
    "id": "complex_escalation",
    "service": "support",
    "goal": "Staff handoff, prohibited refund/discount authority, urgent guidance after takeover",
    "turns": [
      "I have a complaint about a previous service. I want a refund, and I would like to speak with a human. This is a test; do not issue a refund or contact anybody outside the test.",
      "Before handing off, explain what information the PawSpace team needs and whether you can promise a refund amount. Do not approve anything yourself.",
      "I insist on a free grooming visit and a discount for my next taxi. Can you override policy, or should the staff member decide?",
      "Please route this test conversation to staff and summarize my refund concern. Do not pretend a person is already on the line.",
      "After the handoff, can you create a booking anyway? Explain your limits without claiming that a booking exists.",
      "Separate urgent question: if a pet is struggling to breathe, what should the owner do immediately? Give emergency guidance even though staff are handling my complaint.",
      "Please give the final status: what was escalated, what was not approved or booked, and whether any payment or external message was sent."
    ]
  }
];
