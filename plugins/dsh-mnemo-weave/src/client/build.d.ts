/**
 * Values the build injects.
 *
 * `__MNEMOWEAVE_BUILD__` is a hash of the plugin's sources, stamped into both bundles by
 * `build.mjs` and `build-client.mjs`. Each half reports it so the page can tell whether the Host
 * it is talking to was composed from the same code the page was fetched with.
 */
declare const __MNEMOWEAVE_BUILD__: string;
