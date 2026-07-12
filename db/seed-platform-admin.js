// Creates (or resets the password of) a platform admin account — the
// super-admin login that can see every company's users, settings, and
// counts. Deliberately a CLI script, not an HTTP endpoint: an account with
// visibility into every tenant's data should never be creatable over the
// network, even by an authenticated request.
//
// Usage:
//   node db/seed-platform-admin.js you@yourcompany.com "a strong password" "Your Name"
// or set env vars and run with no args:
//   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... PLATFORM_ADMIN_NAME=... node db/seed-platform-admin.js
//
// Works against MongoDB if MONGO_URI is set (production), otherwise the
// local db/db.json file (dev) — same rule server.js itself follows. Set
// env vars the same way you would for `npm start` (this project doesn't use
// a .env loader — export them in your shell, or set them in Render).
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const email = (process.argv[2] || process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.argv[3] || process.env.PLATFORM_ADMIN_PASSWORD;
const name = process.argv[4] || process.env.PLATFORM_ADMIN_NAME || 'Platform Admin';

if (!email || !password) {
  console.error('Usage: node db/seed-platform-admin.js <email> <password> [name]');
  console.error('   or: PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... node db/seed-platform-admin.js');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Use a longer password (8+ characters) for an account with this much visibility.');
  process.exit(1);
}

async function main() {
  const hashed = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();

  if (process.env.MONGO_URI) {
    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGO_URI);
    const PlatformAdmin = mongoose.model('PlatformAdmin', new mongoose.Schema({
      id: String, email: String, password: String, name: String, createdAt: String,
    }));
    const existing = await PlatformAdmin.findOne({ email });
    if (existing) {
      await PlatformAdmin.updateOne({ email }, { $set: { password: hashed, name } });
      console.log(`✅ Updated existing platform admin: ${email}`);
    } else {
      await PlatformAdmin.create({ id: uuid(), email, password: hashed, name, createdAt: now });
      console.log(`✅ Created platform admin: ${email}`);
    }
    await mongoose.disconnect();
  } else {
    const low = require('lowdb');
    const FileSync = require('lowdb/adapters/FileSync');
    const dbPath = path.join(__dirname, 'db.json');
    const adapter = new FileSync(dbPath);
    const db = low(adapter);
    db.defaults({ platformadmins: [] }).write();
    const existing = db.get('platformadmins').find({ email }).value();
    if (existing) {
      db.get('platformadmins').find({ email }).assign({ password: hashed, name }).write();
      console.log(`✅ Updated existing platform admin: ${email} (local db/db.json)`);
    } else {
      db.get('platformadmins').push({ id: uuid(), email, password: hashed, name, createdAt: now }).write();
      console.log(`✅ Created platform admin: ${email} (local db/db.json)`);
    }
  }
  console.log('   Log in at /platform/login.html');
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
