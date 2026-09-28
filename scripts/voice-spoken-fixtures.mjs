// Shared speech and recognition contracts. Never replace genuine ASR with text injection.
export const SPOKEN_QUOTE_TEXT = 'Grooming Essential Bath Bruno tomorrow 11 AM 12 100 Feet Road Indiranagar Bengaluru 560038 healthy adult no aggression no medical issues quote before booking';
export const SPOKEN_QUOTE_EXPECTED = /(?=.*grooming)(?=.*bruno)(?=.*tomorrow)(?=.*11)(?=.*quote)/i;
export const SPOKEN_INFO_TEXT = 'What grooming services do you offer for my dog Bruno?';
export const SPOKEN_INFO_EXPECTED = /(?=.*grooming)(?=.*bruno)/i;
