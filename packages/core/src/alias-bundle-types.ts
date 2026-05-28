/** Minimal metadata captured from a single defineMonitor() call in an alias file. */
export interface MonitorAliasMetadata {
  name: string;
  description?: string;
}

/** Discriminator for alias scripts: freeform side-effect, defineAlias, or defineMonitor. */
export type AliasType = "freeform" | "defineAlias" | "defineMonitor";
