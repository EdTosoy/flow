/** Next 16.4 names these web types; Node 24's pinned types call the dictionary URLPatternInit.
 * Type-only compatibility with the standard URLPattern constructor; no runtime polyfill. */
type URLPatternInput = string | URLPatternInit;
interface URLPatternOptions {
  ignoreCase?: boolean;
}
