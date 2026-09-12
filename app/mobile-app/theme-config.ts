export type ThemeId="emerald"|"signature"|"midnight"|"sage"|"rose"|"ocean";
export type AppearanceMode="system"|"light"|"dark";
export type ThemeOption={id:ThemeId;label:string;tagline:string;swatches:[string,string,string]};
export const THEME_STORAGE_KEY="pawspace.customer.theme";
export const APPEARANCE_STORAGE_KEY="pawspace.customer.appearance";
/** Beta brand lock: only Emerald is offered. Alternate ids remain type-valid for stored prefs but resolve to emerald. */
export const themes:ThemeOption[]=[
{id:"emerald",label:"PawSpace Emerald",tagline:"Deep emerald, gold and ivory — brand standard",swatches:["#01261F","#E6B34E","#f2f7f5"]},
];
const allThemeIds=new Set<ThemeId>(["emerald","signature","midnight","sage","rose","ocean"]);
const appearanceModes=new Set<AppearanceMode>(["system","light","dark"]);
export function isThemeId(value:string|null|undefined):value is ThemeId{return Boolean(value&&allThemeIds.has(value as ThemeId));}
export function isAppearanceMode(value:string|null|undefined):value is AppearanceMode{return Boolean(value&&appearanceModes.has(value as AppearanceMode));}
/** Any legacy stored theme collapses to emerald for a single brand combo. */
export function resolveBrandTheme(value:string|null|undefined):ThemeId{
  if(value==="emerald")return "emerald";
  return "emerald";
}
const configuredTheme=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME:undefined;
const configuredAppearance=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_APPEARANCE:undefined;
export const DEFAULT_THEME:ThemeId=isThemeId(configuredTheme)?resolveBrandTheme(configuredTheme):"emerald";
export const DEFAULT_APPEARANCE:AppearanceMode=isAppearanceMode(configuredAppearance)?configuredAppearance:"system";
