import {SERVICE_ART} from "./service-art";
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
      { image: "/assets/pawspace-grooming-cartoon.webp", alt: "Shih Tzu representing PawSpace grooming" },
      { image: "/assets/pawspace-boarding-cartoon.webp", alt: "Golden Retriever representing PawSpace grooming" },
      { image: "/assets/pawspace-grooming-cartoon.webp", alt: "Persian cat representing PawSpace cat grooming" },
    ],
    videoPoster: "/assets/pawspace-grooming-cartoon.webp",
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
      { image: "/assets/pawspace-training-cartoon.webp", alt: "German Shepherd representing PawSpace dog training" },
      { image: "/assets/pawspace-grooming-cartoon.webp", alt: "Shih Tzu representing PawSpace dog training" },
      { image: "/assets/pawspace-walking-cartoon.webp", alt: "Puppy representing PawSpace foundation training" },
    ],
    videoPoster: "/assets/pawspace-training-cartoon.webp",
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
      { image: "/assets/pawspace-sitting-cartoon.webp", alt: "Large dog receiving home-style boarding care" },
      { image: "/assets/pawspace-boarding-cartoon.webp", alt: "Puppy receiving home-style boarding care" },
      { image: "/assets/pawspace-sitting-cartoon.webp", alt: "Cat-friendly PawSpace home care environment" },
    ],
    videoPoster: "/assets/pawspace-boarding-cartoon.webp",
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
      { image: "/assets/pawspace-sitting-cartoon.webp", alt: "Large Labrador representing PawSpace pet sitting" },
      { image: "/assets/pawspace-boarding-cartoon.webp", alt: "Puppy receiving attentive PawSpace care" },
      { image: "/assets/pawspace-grooming-cartoon.webp", alt: "Persian cat representing PawSpace pet sitting" },
    ],
    videoPoster: "/assets/pawspace-sitting-cartoon.webp",
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
      { image: "/assets/pawspace-walking-cartoon.webp", alt: "Large dog on a PawSpace walk" },
      { image: "/assets/pawspace-walking-cartoon.webp", alt: "Puppy representing shorter PawSpace walks" },
    ],
    videoPoster: "/assets/pawspace-walking-cartoon.webp",
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
      { image: "/assets/pawspace-taxi-cartoon.webp", alt: "Dog travelling safely inside a vehicle" },
      { image: "/assets/pawspace-relocation-cartoon.webp", alt: "Pet transport vehicle representing PawSpace transit support" },
    ],
    videoPoster: "/assets/pawspace-taxi-cartoon.webp",
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
      { image: "/assets/pawspace-food-cartoon.webp", alt: "Fresh pet food being prepared" },
      { image: "/assets/pawspace-food-cartoon.webp", alt: "Fresh PawSpace pet meal ready to serve" },
    ],
    videoPoster: "/assets/pawspace-food-cartoon.webp",
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
      { image: "/assets/pawspace-relocation-cartoon.webp", alt: "Vehicle representing PawSpace pet relocation" },
      { image: "/assets/pawspace-taxi-cartoon.webp", alt: "Pet travelling safely during a PawSpace transfer" },
    ],
    videoPoster: "/assets/pawspace-relocation-cartoon.webp",
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

// Decorative previews use the same AI artwork as discovery, never stock identity photographs.
for (const [code, spec] of Object.entries(SERVICE_MEDIA)) {
  const art = SERVICE_ART[code];
  if (art) { spec.visuals = [{image:art.image,alt:art.alt}]; spec.videoPoster = art.image; }
}
