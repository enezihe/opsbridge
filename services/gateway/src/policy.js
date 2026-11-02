/**
 * Entry-point authorisation table. Deny by default: a request that matches no rule never reaches the API.
 * Roles are cumulative (admin > engineer > viewer), mirroring the realm roles in infra/keycloak.
 */
export const ROLE_ORDER = ['viewer', 'engineer', 'admin'];

const ID = '[^/]+';
const rule = (method, pattern, access) => ({ method, regex: new RegExp(`^${pattern}/?$`), access, label: pattern.replace(ID, ':id') });

export const POLICY = [
  rule('POST', '/auth/login', 'public'),
  rule('POST', '/auth/register', 'public'),
  rule('GET', '/me', 'viewer'),
  rule('GET', '/stats', 'viewer'),
  rule('GET', '/incidents', 'viewer'),
  rule('GET', `/incidents/${ID}`, 'viewer'),
  rule('POST', '/incidents', 'engineer'),
  rule('PATCH', `/incidents/${ID}`, 'engineer'),
  rule('POST', `/incidents/${ID}/notes`, 'engineer'),
  rule('GET', '/audit', 'engineer'),
  rule('DELETE', `/incidents/${ID}`, 'admin'),
  rule('GET', '/admin/chaos', 'admin'),
  rule('PUT', '/admin/chaos', 'admin'),
];

export const findRule = (method, path) => POLICY.find((r) => r.method === method && r.regex.test(path));

export const hasRole = (userRoles, minimum) => Math.max(-1, ...userRoles.map((r) => ROLE_ORDER.indexOf(r))) >= ROLE_ORDER.indexOf(minimum);
