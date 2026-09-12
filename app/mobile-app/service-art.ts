/** Illustrative service artwork only. Never use these as customer/provider identity or service proof. */
export const SERVICE_ART: Record<string, { image: string; alt: string; illustrated?: boolean }> = {
  grooming: { image: "/assets/pawspace-grooming-cartoon.webp", alt: "Illustrated Shih Tzu, Golden Retriever and Persian cat ready for grooming", illustrated: true },
  dog_training: { image: "/assets/pawspace-training-cartoon.webp", alt: "Illustrated German Shepherd, Shih Tzu, Golden Retriever and puppy in training", illustrated: true },
  boarding: { image: "/assets/pawspace-boarding-cartoon.webp", alt: "Illustrated big dog, puppy and cat in a homely boarding stay", illustrated: true },
  pet_sitting: { image: "/assets/pawspace-sitting-cartoon.webp", alt: "Illustrated dog, puppy and cat with an at-home sitter", illustrated: true },
  dog_walking: { image: "/assets/pawspace-walking-cartoon.webp", alt: "Illustrated large dog and puppy on a walk", illustrated: true },
  pet_taxi: { image: "/assets/pawspace-taxi-cartoon.webp", alt: "Illustrated happy dog looking out of a PawSpace taxi", illustrated: true },
  food: { image: "/assets/pawspace-food-cartoon.webp", alt: "Illustrated dog and cat with a fresh meal bowl", illustrated: true },
  relocation: { image: "/assets/pawspace-relocation-cartoon.webp", alt: "Illustrated dog and cat in travel crates for relocation", illustrated: true },
};
