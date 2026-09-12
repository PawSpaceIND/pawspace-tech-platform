export type ThemeId="emerald"|"signature"|"midnight"|"sage"|"rose"|"ocean";
export type AppearanceMode="system"|"light"|"dark";
export type ThemeOption={id:ThemeId;label:string;tagline:string;swatches:[string,string,string]};
export const THEME_STORAGE_KEY="pawspace.customer.theme";
export const APPEARANCE_STORAGE_KEY="pawspace.customer.appearance";
export const PLATFORM_THEME_STORAGE_KEY="pawspace.platform.default-theme";
/** Offered themes: Emerald kit + official brand-book purple/gold. Other ids stay type-valid for stored prefs. */
export const themes:ThemeOption[]=[
{id:"emerald",label:"PawSpace Emerald",tagline:"Deep emerald, gold and ivory — current kit",swatches:["#01261F","#E6B34E","#FFF8EE"]},
{id:"signature",label:"Brand book",tagline:"Lavender indigo #894AED + Gold Fusion #FFAF00",swatches:["#894AED","#FFAF00","#F7F3FF"]},
];
const allThemeIds=new Set<ThemeId>(["emerald","signature","midnight","sage","rose","ocean"]);
const offeredThemeIds=new Set<ThemeId>(["emerald","signature"]);
const appearanceModes=new Set<AppearanceMode>(["system","light","dark"]);
export function isThemeId(value:string|null|undefined):value is ThemeId{return Boolean(value&&allThemeIds.has(value as ThemeId));}
export function isOfferedTheme(value:string|null|undefined):value is ThemeId{return value==="emerald"||value==="signature";}
export function isAppearanceMode(value:string|null|undefined):value is AppearanceMode{return Boolean(value&&appearanceModes.has(value as AppearanceMode));}
export function resolveBrandTheme(value:string|null|undefined):ThemeId{
  if(value==="signature")return "signature";
  if(value==="emerald")return "emerald";
  return "emerald";
}
export function readPlatformDefaultTheme():ThemeId{
  try{
    if(typeof localStorage!=="undefined"){
      const stored=localStorage.getItem(PLATFORM_THEME_STORAGE_KEY);
      if(isOfferedTheme(stored))return stored;
    }
  }catch{ /* Device-only default. */ }
  const configuredTheme=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME:undefined;
  return isOfferedTheme(configuredTheme)?configuredTheme:"emerald";
}
const configuredTheme=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME:undefined;
const configuredAppearance=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_APPEARANCE:undefined;
export const DEFAULT_THEME:ThemeId=isOfferedTheme(configuredTheme)?configuredTheme:"emerald";
export const DEFAULT_APPEARANCE:AppearanceMode=isAppearanceMode(configuredAppearance)?configuredAppearance:"system";
export const OFFERED_THEME_IDS=offeredThemeIds;
