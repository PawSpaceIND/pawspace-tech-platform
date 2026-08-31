export type ServiceVisual = {
  image: string;
  alt: string;
};

export type ServiceMediaSpec = {
  serviceCode: string;
  serviceName: string;
  headline: string;
  sub: string;
  breedLine: string;
  visuals: ServiceVisual[];
  videoPoster: string;
  videoFile: string;
  videoTitle: string;
};

export const SERVICE_MEDIA: Record<string, ServiceMediaSpec> = {
  grooming: {
    serviceCode: "grooming",
    serviceName: "Grooming",
    headline: "Grooming that looks good and feels calm",
    sub: "Doorstep care for coats, paws and comfort — with the package clearly explained before you book.",
    breedLine: "Shih Tzu · Golden Retriever · Persian cat",
    visuals: [
      { image: "/assets/breeds/shih-tzu-hero.jpg", alt: "Shih Tzu representing PawSpace grooming" },
      { image: "/assets/breeds/golden-retriever-hero.jpg", alt: "Golden Retriever representing PawSpace grooming" },
      { image: "/assets/breeds/persian-cat-hero.jpg", alt: "Persian cat representing PawSpace cat grooming" },
    ],
    videoPoster: "/assets/banners/grooming-groomer-action.jpg",
    videoFile: "grooming-doorstep.mp4",
    videoTitle: "See a real PawSpace doorstep grooming visit",
  },
  dog_training: {
    serviceCode: "dog_training",
    serviceName: "Training",
    headline: "Training for calmer, happier everyday life",
    sub: "Positive coaching for puppies and adult dogs, with pet parents part of the progress.",
    breedLine: "German Shepherd · Shih Tzu · Golden Retriever puppy",
    visuals: [
      { image: "/assets/breeds/german-shepherd-hero.jpg", alt: "German Shepherd representing PawSpace dog training" },
      { image: "/assets/breeds/shih-tzu-hero.jpg", alt: "Shih Tzu representing PawSpace dog training" },
      { image: "/assets/banners/puppy-closeup.jpg", alt: "Puppy representing PawSpace foundation training" },
    ],
    videoPoster: "/assets/banners/training-handshake.jpg",
    videoFile: "training-doorstep.mp4",
    videoTitle: "Watch a real PawSpace training session",
  },
  boarding: {
    serviceCode: "boarding",
    serviceName: "Boarding",
    headline: "A stay that feels like home",
    sub: "Home-style care designed for big dogs, puppies and cat-friendly households.",
    breedLine: "Big dog · Puppy · Cat-friendly home",
    visuals: [
      { image: "/assets/banners/sitter-hug-golden.jpg", alt: "Large dog receiving home-style boarding care" },
      { image: "/assets/banners/boarding-puppy-hug.jpg", alt: "Puppy receiving home-style boarding care" },
      { image: "/assets/banners/sitting-woman-cat.jpg", alt: "Cat-friendly PawSpace home care environment" },
    ],
    videoPoster: "/assets/banners/boarding-tablet-dog.jpg",
    videoFile: "boarding-home-stay.mp4",
    videoTitle: "Tour a real PawSpace home-boarding stay",
  },
  pet_sitting: {
    serviceCode: "pet_sitting",
    serviceName: "Pet Sitting",
    headline: "Trusted care in the place they know best",
    sub: "A familiar home environment for large dogs, puppies and cats while you are away.",
    breedLine: "Big dog · Puppy · Cat",
    visuals: [
      { image: "/assets/breeds/labrador-retriever-hero.jpg", alt: "Large Labrador representing PawSpace pet sitting" },
      { image: "/assets/banners/boarding-puppy-hug.jpg", alt: "Puppy receiving attentive PawSpace care" },
      { image: "/assets/breeds/persian-cat-hero.jpg", alt: "Persian cat representing PawSpace pet sitting" },
    ],
    videoPoster: "/assets/banners/sitting-man-cats.jpg",
    videoFile: "pet-sitting-home-visit.mp4",
    videoTitle: "See a real PawSpace sitting visit",
  },
  dog_walking: {
    serviceCode: "dog_walking",
    serviceName: "Dog Walking",
    headline: "Better walks for every size and stage",
    sub: "Neighbourhood walks with routines shaped around energy, pace and confidence.",
    breedLine: "Large dog · Puppy",
    visuals: [
      { image: "/assets/banners/walking-husky-forest.jpg", alt: "Large dog on a PawSpace walk" },
      { image: "/assets/banners/puppy-closeup.jpg", alt: "Puppy representing shorter PawSpace walks" },
    ],
    videoPoster: "/assets/banners/walking-leash-city.jpg",
    videoFile: "dog-walking-doorstep.mp4",
    videoTitle: "Watch a real PawSpace walk from handover to return",
  },
  pet_taxi: {
    serviceCode: "pet_taxi",
    serviceName: "Pet Taxi",
    headline: "Safer pet travel from pickup to handover",
    sub: "Clear pickup, transit and drop details for dogs and cats travelling across the city.",
    breedLine: "Dog / cat in vehicle · Transit-ready setup",
    visuals: [
      { image: "/assets/banners/taxi-car-window.jpg", alt: "Dog travelling safely inside a vehicle" },
      { image: "/assets/banners/taxi-vintage-truck.jpg", alt: "Pet transport vehicle representing PawSpace transit support" },
    ],
    videoPoster: "/assets/banners/taxi-car-window.jpg",
    videoFile: "pet-taxi-pickup.mp4",
    videoTitle: "See a real PawSpace pickup and handover",
  },
  food: {
    serviceCode: "food",
    serviceName: "Fresh Food",
    headline: "Fresh meals, prepared with care",
    sub: "Understand preparation, portions and delivery before you place an order.",
    breedLine: "Fresh preparation · Doorstep delivery",
    visuals: [
      { image: "/assets/banners/food-prep-pouring.jpg", alt: "Fresh pet food being prepared" },
      { image: "/assets/banners/food-prep-bowl.jpg", alt: "Fresh PawSpace pet meal ready to serve" },
    ],
    videoPoster: "/assets/banners/food-prep-pouring.jpg",
    videoFile: "fresh-food-delivery.mp4",
    videoTitle: "See preparation and a real PawSpace food delivery",
  },
  relocation: {
    serviceCode: "relocation",
    serviceName: "Relocation",
    headline: "Pet relocation with calm, guided support",
    sub: "A clearer view of vehicle transfer, transit preparation and handover steps.",
    breedLine: "Vehicle transfer · Transit crate workflow",
    visuals: [
      { image: "/assets/banners/taxi-vintage-truck.jpg", alt: "Vehicle representing PawSpace pet relocation" },
      { image: "/assets/banners/taxi-car-window.jpg", alt: "Pet travelling safely during a PawSpace transfer" },
    ],
    videoPoster: "/assets/banners/taxi-vintage-truck.jpg",
    videoFile: "pet-relocation-transit.mp4",
    videoTitle: "See a real PawSpace relocation handover",
  },
};

export function getServiceMedia(serviceCode: string): ServiceMediaSpec | undefined {
  return SERVICE_MEDIA[serviceCode];
}

export function getServiceMediaByName(serviceName?: string): ServiceMediaSpec | undefined {
  if (!serviceName) return undefined;
  return Object.values(SERVICE_MEDIA).find((item) => item.serviceName === serviceName);
}

export function getServiceVideoUrl(serviceCode: string): string | null {
  const spec = SERVICE_MEDIA[serviceCode];
  const rawBase = process.env.NEXT_PUBLIC_PAWSPACE_SERVICE_VIDEO_BASE;
  if (!spec || !rawBase) return null;
  const base = rawBase.replace(/\/$/, "");
  return `${base}/${spec.videoFile}`;
}
