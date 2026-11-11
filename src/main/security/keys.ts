/**
 * Pinned preset-signing key.
 *
 * This is the only key the integrity gate trusts. It is compiled into the app on purpose:
 * rotating it requires shipping a new build and re-signing the bundled library, so a
 * compromised catalog endpoint cannot substitute its own key.
 *
 * The matching private key is kept out of the repository (development copy lives in the
 * git-ignored `tmp/` directory) and is used by `scripts/sign-presets.mjs`.
 */
export const PRESET_SIGNING_KEY_ID = 'tunesmith-presets-2026';

export const PRESET_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQbWJ+lrspQvJAMeNod4IeVz6DA1cnx3XQUblAe0gKMc=
-----END PUBLIC KEY-----
`;
