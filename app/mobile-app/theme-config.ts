export type ThemeId="signature"|"midnight"|"sage"|"rose"|"ocean";
export type AppearanceMode="system"|"light"|"dark";
export type ThemeOption={id:ThemeId;label:string;tagline:string;swatches:[string,string,string]};
export const THEME_STORAGE_KEY="pawspace.customer.theme";
export const APPEARANCE_STORAGE_KEY="pawspace.customer.appearance";
export const themes:ThemeOption[]=[
{id:"signature",label:"PawSpace Signature",tagline:"Iconic purple, saffron and ivory",swatches:["#5d22a8","#ffb128","#f7f5fa"]},
{id:"midnight",label:"Midnight Luxe",tagline:"Deep plum, violet and champagne",swatches:["#25103f","#9b6de3","#e8c985"]},
{id:"sage",label:"Sage Serenity",tagline:"Calm sage, forest and warm cream",swatches:["#295f4e","#7fa58c","#f4efe5"]},
{id:"rose",label:"Rose Gold",tagline:"Burgundy, blush and rose gold",swatches:["#7c2946","#c98983","#f8ece9"]},
{id:"ocean",label:"Ocean Premium",tagline:"Deep teal, aqua and pearl",swatches:["#07566b","#35a9b8","#eef8f9"]},
];
const themeIds=new Set(themes.map(theme=>theme.id));
const appearanceModes=new Set<AppearanceMode>(["system","light","dark"]);
export function isThemeId(value:string|null|undefined):value is ThemeId{return Boolean(value&&themeIds.has(value as ThemeId));}
export function isAppearanceMode(value:string|null|undefined):value is AppearanceMode{return Boolean(value&&appearanceModes.has(value as AppearanceMode));}
const configuredTheme=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME:undefined;
const configuredAppearance=typeof process!=="undefined"?process.env.NEXT_PUBLIC_PAWSPACE_DEFAULT_APPEARANCE:undefined;
export const DEFAULT_THEME:ThemeId=isThemeId(configuredTheme)?configuredTheme:"signature";
export const DEFAULT_APPEARANCE:AppearanceMode=isAppearanceMode(configuredAppearance)?configuredAppearance:"system";
