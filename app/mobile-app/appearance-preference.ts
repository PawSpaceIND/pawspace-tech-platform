import {APPEARANCE_STORAGE_KEY,DEFAULT_APPEARANCE,DEFAULT_THEME,PLATFORM_THEME_STORAGE_KEY,THEME_STORAGE_KEY,isAppearanceMode,isThemeId,resolveBrandTheme,type AppearanceMode,type ThemeId} from "./theme-config";
/** Legacy compatibility shell only: mirrors the shared resolution for device values, never writes, and renders only approved themes. */
export function readMobileAppearance(storage:{getItem:(key:string)=>string|null},detail?:{theme?:string;mode?:string}):{theme:ThemeId;mode:AppearanceMode} {
 let theme:ThemeId=DEFAULT_THEME,mode:AppearanceMode=DEFAULT_APPEARANCE;
 try {
  const saved=storage.getItem(THEME_STORAGE_KEY),savedMode=storage.getItem(APPEARANCE_STORAGE_KEY),platform=storage.getItem(PLATFORM_THEME_STORAGE_KEY);
  theme=resolveBrandTheme(isThemeId(saved)?saved:isThemeId(platform)?platform:null);
  if(isAppearanceMode(savedMode))mode=savedMode;
 } catch { /* Same defaults as the global controller if storage is unavailable. */ }
 if(detail?.theme)theme=resolveBrandTheme(detail.theme);
 if(isAppearanceMode(detail?.mode))mode=detail.mode;
 return {theme,mode};
}
