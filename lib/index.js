/**
 * Host half of dsh-sidebar-manager.
 *
 * The plugin is browser-only: every behavior lives in `lib/client.js` (the
 * `dsh.client` half). This module exists so the package is a normal Cordis
 * plugin row that a profile can mount, and so the client scan finds the
 * package through an enabled Loader entry.
 *
 * No host-side behavior.
 */
export const name = 'dsh-sidebar-manager'

export function apply() {}
