/* Approved appearance model (native design handoff, 3 Oct 2026): one shared layout, two theme identities.
   "editorial" = Editorial Sanctuary (A), the default and safe fallback. "concierge" = Modern Concierge (C), offered only
   after its release gate passes. Legacy palette and Professional/Fun values are migration metadata only and never render. */
export type ThemeId="editorial"|"concierge";
export type LegacyThemeId="emerald"|"signature"|"coral"|"midnight"|"sage"|"rose"|"ocean";
export type AppearanceMode="system"|"light"|"dark";
export type ThemeOption={id:ThemeId;label:string;tagline:string;swatches:[string,string,string];availableAfterValidation?:true};
/* Legacy device keys. Read once for migration into the appearance record; they no longer decide the rendered theme. */
export const THEME_STORAGE_KEY="pawspace.customer.theme";
export const APPEARANCE_STORAGE_KEY="pawspace.customer.appearance";
export const PLATFORM_THEME_STORAGE_KEY="pawspace.platform.default-theme";
/** The two approved appearance names. Concierge stays listed so the control can show it as not yet available. */
export const themes:ThemeOption[]=[
{id:"editorial",label:"Editorial Sanctuary",tagline:"Forest green, warm ivory and calm editorial type",swatches:["#164A3D","#C46E4D","#F6F3EC"]},
{id:"concierge",label:"Modern Concierge",tagline:"Cobalt, citrus and crisp white",swatches:["#174DC8","#D8EA65","#EDF2FA"],availableAfterValidation:true},
];
const themeIds=new Set<ThemeId>(["editorial","concierge"]);
const legacyThemeIds=new Set<LegacyThemeId>(["emerald","signature","coral","midnight","sage","rose","ocean"]);
const appearanceModes=new Set<AppearanceMode>(["system","light","dark"]);
export const SAFE_THEME:ThemeId="editorial";
/** C release gate. Closed unless the build sets NEXT_PUBLIC_PAWSPACE_CONCIERGE_AVAILABLE=true after every required acceptance case passes. */
export function isConciergeAvailable(flag:string|undefined=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_CONCIERGE_AVAILABLE:undefined):boolean{return flag==="true";}
export const CONCIERGE_AVAILABLE=isConciergeAvailable();
export function isThemeId(value:string|null|undefined):value is ThemeId{return Boolean(value&&themeIds.has(value as ThemeId));}
export function isLegacyThemeId(value:string|null|undefined):value is LegacyThemeId{return Boolean(value&&legacyThemeIds.has(value as LegacyThemeId));}
/** A theme that may render right now: editorial always, concierge only while its gate is open. */
export function isOfferedTheme(value:string|null|undefined,conciergeAvailable:boolean=CONCIERGE_AVAILABLE):value is ThemeId{return value==="editorial"||(value==="concierge"&&conciergeAvailable);}
export function isAppearanceMode(value:string|null|undefined):value is AppearanceMode{return Boolean(value&&appearanceModes.has(value as AppearanceMode));}
/** Effective theme for any stored or submitted value: a gated or unknown value renders the safe theme without being rewritten. */
export function resolveBrandTheme(value:string|null|undefined,conciergeAvailable:boolean=CONCIERGE_AVAILABLE):ThemeId{
  if(isOfferedTheme(value,conciergeAvailable))return value;
  return SAFE_THEME;
}
/** New-user default supplied by the build (NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME). Only A, or C while its gate is open, is accepted. */
export function readPlatformDefaultTheme():ThemeId{
  const configuredTheme=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME:undefined;
  return isOfferedTheme(configuredTheme)?configuredTheme:SAFE_THEME;
}
const configuredAppearance=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_APPEARANCE:undefined;
export const DEFAULT_THEME:ThemeId=readPlatformDefaultTheme();
export const DEFAULT_APPEARANCE:AppearanceMode=isAppearanceMode(configuredAppearance)?configuredAppearance:"system";
export const OFFERED_THEME_IDS:ReadonlySet<ThemeId>=new Set<ThemeId>(CONCIERGE_AVAILABLE?["editorial","concierge"]:["editorial"]);

/* Professional/Fun no longer selects a layout. The shared layout always renders the professional structure; a stored
   "cartoon" value is kept only as inactive migration metadata. */
export type VisualStyle = "professional" | "cartoon";
export const STYLE_STORAGE_KEY = "pawspace.visual-style";
export const DEFAULT_STYLE: VisualStyle = "professional";
export function resolveVisualStyle(value: string | null): VisualStyle { return value === "cartoon" ? "cartoon" : DEFAULT_STYLE; }
