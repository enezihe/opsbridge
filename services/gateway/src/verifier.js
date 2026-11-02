import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ROLE_ORDER } from './policy.js';

const knownRoles = (roles) => (Array.isArray(roles) ? roles.filter((r) => ROLE_ORDER.includes(r)) : []);

/** Returns async (token) => { id, email, roles }. Throws on any invalid token. */
export function createVerifier(config, { keyResolver } = {}) {
  if (config.authMode === 'keycloak') {
    const keys = keyResolver ?? createRemoteJWKSet(new URL(config.keycloakJwksUrl), { cooldownDuration: 30_000, timeoutDuration: 5_000 });
    return async (token) => {
      const { payload } = await jwtVerify(token, keys, { issuer: config.keycloakIssuer, algorithms: ['RS256'] });
      // Keycloak puts realm roles in realm_access.roles; client-specific roles are deliberately ignored.
      return { id: payload.sub, email: payload.email ?? payload.preferred_username, roles: knownRoles(payload.realm_access?.roles) };
    };
  }
  const secret = new TextEncoder().encode(config.jwtSecret);
  return async (token) => {
    const { payload } = await jwtVerify(token, secret, { issuer: 'opsbridge-api', algorithms: ['HS256'] });
    return { id: payload.sub, email: payload.email, roles: knownRoles(payload.roles) };
  };
}
