export function loadConfig(env = process.env) {
  const config = {
    port: Number(env.PORT ?? 8080),
    upstream: env.UPSTREAM_URL ?? 'http://localhost:3000',
    // local    : HS256 tokens issued by the API (/auth/login).
    // keycloak : RS256 tokens issued by Keycloak, verified against its JWKS endpoint.
    authMode: env.AUTH_MODE ?? 'local',
    jwtSecret: env.JWT_SECRET ?? '',
    keycloakIssuer: env.KEYCLOAK_ISSUER ?? '',
    keycloakJwksUrl: env.KEYCLOAK_JWKS_URL ?? (env.KEYCLOAK_ISSUER ? `${env.KEYCLOAK_ISSUER}/protocol/openid-connect/certs` : ''),
    internalKey: env.INTERNAL_KEY ?? '',
    forwardAuthorization: (env.FORWARD_AUTHORIZATION ?? (env.AUTH_MODE === 'keycloak' ? 'false' : 'true')) === 'true',
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 300),
    authRateLimitPerMinute: Number(env.AUTH_RATE_LIMIT_PER_MINUTE ?? 10),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 10_000),
    maxBodyBytes: 100 * 1024,
  };
  const problems = [];
  if (!['local', 'keycloak'].includes(config.authMode)) problems.push('AUTH_MODE must be "local" or "keycloak"');
  if (config.authMode === 'local' && !config.jwtSecret) problems.push('JWT_SECRET is required in local mode');
  if (config.authMode === 'keycloak' && !config.keycloakIssuer) problems.push('KEYCLOAK_ISSUER is required in keycloak mode');
  if (config.authMode === 'keycloak' && config.internalKey.length < 16) problems.push('INTERNAL_KEY (>=16 chars) is required in keycloak mode');
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  return config;
}
