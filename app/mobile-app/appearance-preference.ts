import {APPEARANCE_STORAGE_KEY,DEFAULT_APPEARANCE,DEFAULT_THEME,PLATFORM_THEME_STORAGE_KEY,THEME_STORAGE_KEY,isAppearanceMode,isOfferedTheme,resolveBrandTheme,type AppearanceMode,type ThemeId} from "./theme-config";
/** Mirrors PawSpaceAppearance precedence; device presentation only, no writes. */
export function readMobileAppearance(storage:{getItem:(key:string)=>string|null},detail?:{theme?:string;mode?:string}):{theme:ThemeId;mode:AppearanceMode} {
 let theme:ThemeId=DEFAULT_THEME,mode:AppearanceMode=DEFAULT_APPEARANCE;
 try {
  const saved=storage.getItem(THEME_STORAGE_KEY),savedMode=storage.getItem(APPEARANCE_STORAGE_KEY),platform=storage.getItem(PLATFORM_THEME_STORAGE_KEY);
  theme=isOfferedTheme(saved)?saved:isOfferedTheme(platform)?platform:resolveBrandTheme(saved);
  if(isAppearanceMode(savedMode))mode=savedMode;
 } catch { /* Same defaults as the global controller if storage is unavailable. */ }
 if(detail?.theme)theme=resolveBrandTheme(detail.theme);
 if(isAppearanceMode(detail?.mode))mode=detail.mode;
 return {theme,mode};
}
