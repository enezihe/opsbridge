import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createLogger } from '@opsbridge/common';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/auth.js';
import { User } from '../src/models.js';

export async function startHarness(env = {}) {
  const mongo = process.env.MONGO_URL ? null : await MongoMemoryServer.create();
  const uri = process.env.MONGO_URL ?? mongo.getUri('opsbridge_test');
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const config = loadConfig({ BCRYPT_COST: '4', JWT_SECRET: 'test-secret', ENABLE_CHAOS: 'true', ...env });
  const lines = [];
  const logger = createLogger('api-test', { sink: (l) => lines.push(JSON.parse(l)) });
  const server = createApp({ config, logger }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };

  const password = 'Sup3rSecret!pass';
  const login = async (email, roles) => {
    await User.create({ email, roles, passwordHash: await hashPassword(password, 4) });
    return (await call('POST', '/auth/login', { body: { email, password } })).body.accessToken;
  };

  return {
    call, login, lines, config, password,
    async close() {
      server.close();
      await mongoose.disconnect();
      await mongo?.stop();
    },
  };
}
