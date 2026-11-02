import mongoose from 'mongoose';
import { hashPassword } from './auth.js';
import { loadConfig } from './config.js';
import { User } from './models.js';

// Local demo users only. Password comes from SEED_PASSWORD so nothing real is ever committed.
const config = loadConfig();
const password = process.env.SEED_PASSWORD ?? 'ChangeMe!12345';
await mongoose.connect(config.mongoUrl);
for (const [email, roles] of [
  ['admin@opsbridge.local', ['admin']],
  ['engineer@opsbridge.local', ['engineer']],
  ['viewer@opsbridge.local', ['viewer']],
]) {
  await User.updateOne({ email }, { $set: { roles, passwordHash: await hashPassword(password, config.bcryptCost) } }, { upsert: true });
  console.log(`seeded ${email} (${roles})`);
}
await mongoose.disconnect();
