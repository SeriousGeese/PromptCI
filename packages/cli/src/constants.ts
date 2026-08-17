/**
 * Build-time constants for the CLI bundle.
 *
 * SUPABASE_URL can be injected at build time via:
 *   esbuild --define:__SUPABASE_URL__='"https://your-ref.supabase.co"'
 * or overridden at runtime via the SUPABASE_URL environment variable.
 * If neither is provided, ensure-fresh-token derives it from the JWT issuer claim.
 */
declare const __SUPABASE_URL__: string | undefined;

export const SUPABASE_URL: string =
  (typeof __SUPABASE_URL__ !== 'undefined' ? __SUPABASE_URL__ : '') ||
  process.env['SUPABASE_URL'] ||
  '';
