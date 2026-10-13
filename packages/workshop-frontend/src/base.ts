// Path prefix the build is served under (qyvr patch 2, AD-13): `VITE_QYVR_BASE=/workshop/` makes
// Vite's `base` (and so `import.meta.env.BASE_URL`) `/workshop/`; unset, the app is served at `/`.
// `BASE` has no trailing slash, so `${BASE}/api` is `/api` at the root and `/workshop/api` under a
// prefix. The server (behind a proxy that strips the prefix) keeps naming its own paths from `/`.

/** The prefix without a trailing slash: `''` at the root, `'/workshop'` under a prefix. */
export const BASE: string = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '')

/** A root-relative path (`/api/x`, as the server names them) made relative to the prefix. */
export function withBase(path: string): string {
  return path.startsWith('/') && !path.startsWith('//') ? `${BASE}${path}` : path
}
