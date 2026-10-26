/** Names the page script and the Bun side agree on. */

/** The page script's helpers, called through `evaluate`. */
export const PAGE_HELPERS_GLOBAL = "__vt";

/** Set ahead of the page script in each test's copy of it: `{ now }`. */
export const PAGE_CONFIG_GLOBAL = "__uiverifyBun";

/** The CDP binding the page calls for a resource it can't read itself. */
export const OUTSIDE_PAGE_BINDING = "__uiverifyOutsidePage";
