import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { SignJWT, generateKeyPair } from 'jose';
import { createLogger } from '@opsbridge/common';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createVerifier } from '../src/verifier.js';

const logger = createLogger('gw-test', { sink: () => {} });
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

async function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen, port: await listen(server) };
}

const secret = new TextEncoder().encode('gw-test-secret');
const localToken = (roles, opts = {}) =>
  new SignJWT({ roles, email: 'u@test.io' }).setProtectedHeader({ alg: 'HS256' }).setSubject('user-1').setIssuer('opsbridge-api').setExpirationTime(opts.exp ?? '5m').sign(secret);

async function startGateway(env, upstreamPort, extra = {}) {
  const config = loadConfig({ UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`, JWT_SECRET: 'gw-test-secret', INTERNAL_KEY: 'internal-key-1234567890', ...env });
  const server = createApp({ config, logger, ...extra }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, headers = {}, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }), ...headers }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { server, call };
}

describe('gateway (local JWT mode)', () => {
  let up; let gw;
  before(async () => {
    up = await startUpstream();
    gw = await startGateway({ AUTH_RATE_LIMIT_PER_MINUTE: '3' }, up.port);
  });
  after(() => { gw.server.close(); up.server.close(); });

  it('denies by default: unknown routes never reach the upstream', async () => {
    const r = await gw.call('GET', '/internal/secrets', { token: await localToken(['admin']) });
    assert.equal(r.status, 404);
    assert.equal(up.seen.length, 0);
  });

  it('401 without a token or with a forged one', async () => {
    assert.equal((await gw.call('GET', '/incidents')).status, 401);
    const forged = await new SignJWT({ roles: ['admin'] }).setProtectedHeader({ alg: 'HS256' }).setSubject('x').setIssuer('opsbridge-api').sign(new TextEncoder().encode('wrong-secret'));
    assert.equal((await gw.call('GET', '/incidents', { token: forged })).status, 401);
    const expired = await localToken(['admin'], { exp: Math.floor(Date.now() / 1000) - 60 });
    const r = await gw.call('GET', '/incidents', { token: expired });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.message, 'Token expired');
    assert.equal(up.seen.length, 0);
  });

  it('403 when the role is too low, and the upstream is not called', async () => {
    const r = await gw.call('POST', '/incidents', { token: await localToken(['viewer']), body: { title: 'x' } });
    assert.equal(r.status, 403);
    assert.equal((await gw.call('DELETE', '/incidents/abc', { token: await localToken(['engineer']) })).status, 403);
    assert.equal(up.seen.length, 0);
  });

  it('forwards allowed requests with verified identity, replacing spoofed headers', async () => {
    const r = await gw.call('GET', '/incidents?status=open', { token: await localToken(['engineer']), headers: { 'x-user-roles': 'admin', 'x-user-id': 'attacker', 'x-internal-key': 'guess' } });
    assert.equal(r.status, 200);
    const seen = up.seen.at(-1);
    assert.equal(seen.url, '/incidents?status=open');
    assert.equal(seen.headers['x-user-id'], 'user-1');
    assert.equal(seen.headers['x-user-roles'], 'engineer');
    assert.equal(seen.headers['x-internal-key'], 'internal-key-1234567890');
  });

  it('propagates the W3C trace context to the upstream', async () => {
    const traceId = 'c'.repeat(32);
    const r = await gw.call('GET', '/me', { token: await localToken(['viewer']), headers: { traceparent: `00-${traceId}-${'d'.repeat(16)}-01` } });
    assert.equal(r.headers.get('x-trace-id'), traceId);
    assert.match(up.seen.at(-1).headers.traceparent, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    assert.notEqual(up.seen.at(-1).headers.traceparent.split('-')[2], 'd'.repeat(16), 'gateway starts its own span');
  });

  it('rate limits the auth endpoints (brute-force protection)', async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await gw.call('POST', '/auth/login', { body: { email: 'a@b.io', password: 'x' } })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  });

  it('rejects oversized bodies with 413', async () => {
    const r = await gw.call('POST', '/incidents', { token: await localToken(['engineer']), body: { title: 'x'.repeat(200_000) } }).catch((e) => ({ status: 'reset', e }));
    assert.ok([413, 'reset'].includes(r.status));
  });
});

describe('gateway (upstream down)', () => {
  it('returns 502 with a trace id instead of hanging', async () => {
    const gw = await startGateway({}, 1);
    const r = await gw.call('GET', '/me', { token: await localToken(['viewer']) });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'UPSTREAM_UNAVAILABLE');
    assert.ok(r.body.error.traceId);
    gw.server.close();
  });
});

describe('gateway (Keycloak / JWKS mode)', () => {
  let up; let gw; let privateKey; let other;
  const issuer = 'http://keycloak.test/realms/opsbridge';
  const kcToken = (key, claims, iss = issuer) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('kc-user-9').setIssuer(iss).setExpirationTime('5m').sign(key);

  before(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    other = (await generateKeyPair('RS256')).privateKey;
    up = await startUpstream();
    const config = loadConfig({ AUTH_MODE: 'keycloak', KEYCLOAK_ISSUER: issuer, UPSTREAM_URL: `http://127.0.0.1:${up.port}`, INTERNAL_KEY: 'internal-key-1234567890' });
    gw = await startGateway({ AUTH_MODE: 'keycloak', KEYCLOAK_ISSUER: issuer }, up.port, { verifier: createVerifier(config, { keyResolver: async () => pair.publicKey }) });
  });
  after(() => { gw.server.close(); up.server.close(); });

  it('maps realm_access.roles to RBAC and does not forward the bearer token', async () => {
    const token = await kcToken(privateKey, { preferred_username: 'nezihe', realm_access: { roles: ['engineer', 'offline_access'] } });
    assert.equal((await gw.call('POST', '/incidents', { token, body: { title: 'abc', severity: 'sev3', service: 'svc' } })).status, 200);
    const seen = up.seen.at(-1);
    assert.equal(seen.headers['x-user-id'], 'kc-user-9');
    assert.equal(seen.headers['x-user-roles'], 'engineer');
    assert.equal(seen.headers.authorization, undefined);
    assert.equal((await gw.call('DELETE', '/incidents/abc', { token })).status, 403);
  });

  it('rejects tokens signed by another key or issued by another realm', async () => {
    assert.equal((await gw.call('GET', '/me', { token: await kcToken(other, { realm_access: { roles: ['admin'] } }) })).status, 401);
    assert.equal((await gw.call('GET', '/me', { token: await kcToken(privateKey, { realm_access: { roles: ['admin'] } }, 'http://evil/realms/x') })).status, 401);
  });

  it('a valid user with no known realm role gets 403, not access', async () => {
    assert.equal((await gw.call('GET', '/me', { token: await kcToken(privateKey, { realm_access: { roles: ['uma_authorization'] } }) })).status, 403);
  });
});
