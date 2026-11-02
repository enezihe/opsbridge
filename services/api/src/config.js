const DEV_SECRET = 'dev-only-secret-change-me';

export function loadConfig(env = process.env) {
  const config = {
    port: Number(env.PORT ?? 3000),
    mongoUrl: env.MONGO_URL ?? 'mongodb://localhost:27017/opsbridge',
    // local   : the API issues and verifies its own JWTs (register/login). Used standalone and in tests.
    // gateway : the API sits behind the gateway and trusts identity headers signed with INTERNAL_KEY.
    authMode: env.AUTH_MODE ?? 'local',
    jwtSecret: env.JWT_SECRET ?? DEV_SECRET,
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 3600),
    internalKey: env.INTERNAL_KEY ?? '',
    bcryptCost: Number(env.BCRYPT_COST ?? 10),
    kafkaBrokers: env.KAFKA_BROKERS ? env.KAFKA_BROKERS.split(',') : null,
    eventsTopic: env.EVENTS_TOPIC ?? 'incident.events',
    enableChaos: env.ENABLE_CHAOS === 'true',
    isProduction: env.NODE_ENV === 'production',
  };

  const problems = [];
  if (!['local', 'gateway'].includes(config.authMode)) problems.push('AUTH_MODE must be "local" or "gateway"');
  if (config.authMode === 'local' && config.isProduction && config.jwtSecret === DEV_SECRET) problems.push('JWT_SECRET must be set in production');
  if (config.authMode === 'gateway' && config.internalKey.length < 16) problems.push('INTERNAL_KEY (>=16 chars) is required when AUTH_MODE=gateway');
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  return config;
}
