/** Illustrative service artwork only. Never use these as customer/provider identity or service proof. */
export const SERVICE_ART: Record<string, { image: string; alt: string; illustrated?: boolean }> = {
  grooming: { image: "/assets/pawspace-grooming-editorial.webp", alt: "AI illustration: professional brushing a Shih Tzu at home, with a Golden Retriever and Persian cat nearby", illustrated: true },
  dog_training: { image: "/assets/pawspace-training-editorial.webp", alt: "AI illustration: trainer rewarding a Golden Retriever puppy beside a German Shepherd and Shih Tzu", illustrated: true },
  boarding: { image: "/assets/banners/boarding-puppy-hug.jpg", alt: "Caregiver holding a puppy in a home setting" },
  pet_sitting: { image: "/assets/banners/sitting-woman-cat.jpg", alt: "Caregiver holding a cat at home" },
  dog_walking: { image: "/assets/pawspace-walking-editorial.webp", alt: "AI illustration: walker leaving home with a harnessed Golden Retriever and puppy", illustrated: true },
  pet_taxi: { image: "/assets/banners/taxi-car-window.jpg", alt: "Dog in a car, illustrating pet transport" },
  food: { image: "/assets/banners/food-prep-bowl.jpg", alt: "Fresh pet food being prepared in a bowl" },
  relocation: { image: "/assets/banners/taxi-vintage-truck.jpg", alt: "Vehicle illustrating the road-transfer part of pet relocation" },
};
