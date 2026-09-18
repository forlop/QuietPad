// Vite's `?inline` query returns the stylesheet text as a string.
declare module "*?inline" {
  const content: string;
  export default content;
}

// turndown-plugin-gfm ships no types; declare the plugins we use.
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}
