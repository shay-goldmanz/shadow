/** Bun bundles these at serve time (D7); `tsc` only needs to know they resolve. */
declare module "*.css";
declare module "*.html" {
  const value: unknown;
  export default value;
}
