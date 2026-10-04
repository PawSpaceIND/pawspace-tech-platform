"use client";
/* eslint-disable @next/next/no-img-element */

import type { CSSProperties } from "react";
import { useEffectiveTheme } from "./appearance-context";
import type { ThemeId } from "../mobile-app/theme-config";

/*
 * Approved decorative artwork from the native A/C handoff (public/assets/native/asset-manifest.json). Every file is
 * original AI-generated concept art: illustrative only, never an actual provider, customer, proof or testimonial.
 * Only the effective theme's files are rendered; nothing is preloaded for the other theme.
 */
const ART_ROOT = "/assets/native";
const HERO = { widths: [640, 960, 1536], fallback: "hero-fallback.jpg", width: 1536, height: 1024 } as const;
const SHEET = { widths: [642, 960, 1254], fallback: "service-sheet-fallback.jpg", size: 1254 } as const;

/** Nine square scenes per sheet, read left to right then top to bottom; coordinates are the manifest's exact values. */
export type ServiceSceneCode = "grooming" | "boarding" | "dog_training" | "pet_sitting" | "dog_walking" | "food" | "pet_taxi" | "relocation" | "family";
const SCENE_INDEX: Record<ServiceSceneCode, number> = { grooming: 0, boarding: 1, dog_training: 2, pet_sitting: 3, dog_walking: 4, food: 5, pet_taxi: 6, relocation: 7, family: 8 };
const SCENE_ALT: Record<ServiceSceneCode, string> = {
  grooming: "Illustrative grooming scene with a dog and a carer",
  boarding: "Illustrative boarding scene with a pet and its hosts",
  dog_training: "Illustrative training scene with a dog and a trainer",
  pet_sitting: "Illustrative pet sitting scene with a cat and a sitter",
  dog_walking: "Illustrative dog walking scene",
  food: "Illustrative fresh food preparation scene with a dog",
  pet_taxi: "Illustrative pet taxi scene",
  relocation: "Illustrative relocation scene with a pet carrier",
  family: "Illustrative scene of pet parents with their dog and cat",
};
const SPRITE: Record<ThemeId, { width: number; offsets: number[] }> = {
  // img_width_percent and the column/row offsets from asset-manifest.json (inset 20 px at 1254 for A, 8 px for C).
  editorial: { width: 331.746032, offsets: [-5.291005, -115.873016, -226.455026] },
  concierge: { width: 311.940299, offsets: [-1.99005, -105.970149, -209.950249] },
};

const srcSet = (theme: ThemeId, kind: "hero" | "service-sheet", widths: readonly number[]) => widths.map(w => `${ART_ROOT}/${theme}/${kind}-${w}.webp ${w}w`).join(", ");

/** The 3:2 home hero: both pets visible, contained frame, only the effective theme's sources. */
export function NativeHero({ className }: { className?: string }) {
  const theme = useEffectiveTheme();
  return (
    <picture className={className} data-native-art={`${theme}-hero`}>
      <source type="image/webp" srcSet={srcSet(theme, "hero", HERO.widths)} sizes="(max-width: 767px) 100vw, 50vw" />
      <img src={`${ART_ROOT}/${theme}/${HERO.fallback}`} width={HERO.width} height={HERO.height} alt="Illustrative scene of a golden retriever and a Persian cat resting together at home" decoding="async" fetchPriority="high" />
    </picture>
  );
}

/** One square service scene cut from the effective theme's sheet with the manifest's sprite coordinates. */
export function NativeServiceArt({ service, informative = false, className }: { service: ServiceSceneCode; informative?: boolean; className?: string }) {
  const theme = useEffectiveTheme();
  const index = SCENE_INDEX[service], sprite = SPRITE[theme];
  const style = { "--sprite-width": `${sprite.width}%`, "--sprite-left": `${sprite.offsets[index % 3]}%`, "--sprite-top": `${sprite.offsets[Math.floor(index / 3)]}%` } as CSSProperties;
  return (
    <span className={className ? `ps-service-art ${className}` : "ps-service-art"} style={style} data-native-art={`${theme}-${service}`}>
      <img src={`${ART_ROOT}/${theme}/service-sheet-${SHEET.widths[0]}.webp`} srcSet={srcSet(theme, "service-sheet", SHEET.widths)} sizes="(max-width: 767px) 240px, 360px" width={SHEET.size} height={SHEET.size} alt={informative ? SCENE_ALT[service] : ""} loading="lazy" decoding="async" />
    </span>
  );
}
