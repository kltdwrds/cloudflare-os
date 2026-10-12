import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Cloudflare Access settings required to verify an assertion. */
export type CfAccessEnv = Readonly<{
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ISS?: string;
}>;

type AccessTokenVerifier = (token: string, env: CfAccessEnv) => Promise<JWTPayload>;

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyToken(token: string, env: CfAccessEnv): Promise<JWTPayload> {
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_ISS) {
    throw new Error("Cloudflare Access issuer and audience must both be configured.");
  }
  let jwks = remoteJwkSets.get(env.CF_ACCESS_ISS);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.CF_ACCESS_ISS}/cdn-cgi/access/certs`));
    remoteJwkSets.set(env.CF_ACCESS_ISS, jwks);
  }
  return (await jwtVerify(token, jwks, {
    issuer: env.CF_ACCESS_ISS,
    audience: env.CF_ACCESS_AUD,
  })).payload;
}

/** Returns verified Cloudflare Access claims, or null when the assertion cannot be trusted. */
export async function verifyCfAccessJwt(
    request: Request,
    env: CfAccessEnv,
    verifier: AccessTokenVerifier = verifyToken): Promise<JWTPayload | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    return await verifier(token, env);
  } catch {
    return null;
  }
}

// qyvr patch 1 (AD-17): a platform identity assertion beside Access, for an agent acting for a person.
type Assertion = JWTPayload & { sub: string; jti: string; exp: number };
export async function verifyPlatformAssertion(req: Request, env: CfAccessEnv & { QYVR_ASSERTION_ISS?: string; QYVR_ASSERTION_JWKS?: string }): Promise<Assertion | null> {
  const token = req.headers.get("x-qyvr-assertion");
  if (!token || !env.QYVR_ASSERTION_ISS || !env.QYVR_ASSERTION_JWKS || !env.CF_ACCESS_AUD) return null;
  const { payload } = await jwtVerify(token, createLocalJWKSet(JSON.parse(env.QYVR_ASSERTION_JWKS)), { issuer: env.QYVR_ASSERTION_ISS, audience: env.CF_ACCESS_AUD, algorithms: ["ES256"], maxTokenAge: "10m" }).catch(() => ({ payload: null }));
  return payload?.agent === true && typeof payload.sub === "string" && typeof payload.jti === "string" ? payload as Assertion : null;
}
// An agent session never approves, rejects, shares or connects; what it opens is wrapped the same way.
const AGENT_REFUSED = /^(approve|reject|accept|deny|connect|reconnect|disconnect|completeConnect|ensureAccount|provisionAmbient|startResourceConfigurator|addCollaborator|removeCollaborator|createShareLink|newShareLinkKey|updateShareLink|revokeShareLink|setAutoApproved|removeAutoApproved)/;
export const forAgent = <T extends object>(target: T): T => new Proxy(target, { get(t, p) {
  const v = Reflect.get(t, p);
  if (typeof v !== "function" || typeof p !== "string") return typeof v === "function" ? v.bind(t) : v;
  if (AGENT_REFUSED.test(p)) return () => { throw new Error("AGENT_SESSION_REFUSED"); };
  return /^(open|new)Gadget$/.test(p) ? async (...a: unknown[]) => forAgent(await v.apply(t, a)) : v.bind(t);
} });

/** Returns a privacy-preserving limiter key derived only from verified Access claims. */
export async function accessRateLimitKey(payload: JWTPayload): Promise<string | null> {
  if (payload.sub) return `access-sub:${payload.sub}`;
  if (typeof payload.email !== "string" || payload.email.length === 0) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.email));
  return `access-email:${new Uint8Array(digest).toHex()}`;
}
