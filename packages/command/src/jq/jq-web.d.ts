/**
 * Type declarations for jq-web
 *
 * jq-web is an Emscripten-compiled WASM build of jq.
 * It exports a promise that resolves to { json, raw }.
 */
declare module "jq-web" {
  interface JqModule {
    /**
     * Run jq filter on JSON data, returning parsed result.
     * If the filter produces multiple outputs, returns an array.
     */
    json(data: unknown, filter: string): unknown;

    /**
     * Run jq filter on raw JSON string, returning raw output string.
     */
    raw(jsonString: string, filter: string, flags?: string[]): string;
  }

  // Dev mode: raw Promise. Build plugin: { ready: Promise }.
  const jq: Promise<JqModule> & { ready?: Promise<JqModule> };
  export default jq;
}
