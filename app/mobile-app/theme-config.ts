export type ThemeId="emerald"|"signature"|"midnight"|"sage"|"rose"|"ocean";
export type AppearanceMode="system"|"light"|"dark";
export type ThemeOption={id:ThemeId;label:string;tagline:string;swatches:[string,string,string]};
export const THEME_STORAGE_KEY="pawspace.customer.theme";
export const APPEARANCE_STORAGE_KEY="pawspace.customer.appearance";
export const themes:ThemeOption[]=[
{id:"signature",label:"PawSpace Brand",tagline:"Joyful purple, saffron and warm ivory",swatches:["#6730b9","#ffaf00","#fffcf1"]},
{id:"emerald",label:"Emerald & Gold",tagline:"Forest greens and warm golden details",swatches:["#164a3c","#eac36c","#f4f8f3"]},
{id:"rose",label:"Lagoon & Coral",tagline:"Joyful teal, coral and soft sunshine",swatches:["#075e66","#ff8d77","#f1fcfa"]},
];
const themeIds=new Set(themes.map(theme=>theme.id));
const appearanceModes=new Set<AppearanceMode>(["system","light","dark"]);
export function isThemeId(value:string|null|undefined):value is ThemeId{return Boolean(value&&themeIds.has(value as ThemeId));}
export function isAppearanceMode(value:string|null|undefined):value is AppearanceMode{return Boolean(value&&appearanceModes.has(value as AppearanceMode));}
const configuredTheme=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME:undefined;
const configuredAppearance=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_APPEARANCE:undefined;
export const DEFAULT_THEME:ThemeId=isThemeId(configuredTheme)?configuredTheme:"signature";
export const DEFAULT_APPEARANCE:AppearanceMode=isAppearanceMode(configuredAppearance)?configuredAppearance:"light";
