const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const multer     = require('multer');
const { v4: uuid } = require('uuid');
const mongoose   = require('mongoose');
const https      = require('https');
const XLSX       = require('xlsx');
const pinoHttp   = require('pino-http');
const log        = require('./logger');

const app = express();
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'exhibition-saas-dev-secret';
const MONGO_URI  = process.env.MONGO_URI  || '';
const APP_URL    = process.env.APP_URL    || 'http://localhost:3000';

if (!process.env.JWT_SECRET) {
  log.warn('JWT_SECRET env var not set — using insecure default. Set JWT_SECRET in production!');
}

// ── CLOUDFLARE R2 SETUP (same pattern as ecatlog — zero egress, R2 with local fallback) ──
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET     = process.env.R2_BUCKET_NAME || '';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
let s3Client = null;
let useR2 = false;
let multerS3 = null;
let S3PutObjectCommand = null; // used by the bulk image import route, which writes files manually

function initR2() {
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET && R2_PUBLIC_URL) {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    multerS3 = require('multer-s3');
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
    });
    S3PutObjectCommand = PutObjectCommand;
    useR2 = true;
    log.info('Cloudflare R2 image storage enabled');
  } else {
    log.warn('R2 not configured — using local disk storage (set R2_* env vars to switch)');
  }
}

// ── MONGOOSE SCHEMAS ──────────────────────────────────────────────────────────
const tenantSchema = new mongoose.Schema({
  id: String,
  name: String,                       // "Kaashvi Jewels"
  slug: { type: String, unique: true, sparse: true }, // "kaashvi" -> kaashvi.orders.is
  plan: { type: String, default: 'free' },
  logoUrl: String,
  // Which item fields appear per line on the order link sent to buyers, and
  // which of those (number fields) get summed into a total — admin-configured
  // in Settings > Order Form.
  orderFields: { type: [{ key: String, label: String, unit: String, showTotal: Boolean }], default: [] },
  orderShowImages: { type: Boolean, default: true }, // whether item photos appear on the order link
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const userSchema = new mongoose.Schema({
  id: String, tenantId: String,
  role: String,                       // admin | staff | client
  loginId: String,                    // email or short user id, unique within tenant
  password: String,
  name: String, phone: String, email: String,
  active: { type: Boolean, default: true },
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const fieldDefSchema = new mongoose.Schema({
  id: String, tenantId: String,
  key: String,                        // stable key used inside item.fields map
  label: String,                      // display label, editable by admin
  type: { type: String, default: 'text' }, // text | number | dropdown | date
  options: [String],                  // for type=dropdown
  decimals: { type: Number, default: 2 }, // for type=number — values are rounded to this many places
  unit: { type: String, default: '' },    // for type=number — display suffix, e.g. "Grams", "Rs.", "Mts"
  order: { type: Number, default: 0 },
  isScannerKey: { type: Boolean, default: false }, // true only for the built-in "itemCode" field
  fixed: { type: Boolean, default: false }, // built-in field (Item Code / Image Code) — cannot be deleted
  active: { type: Boolean, default: true },
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const itemSchema = new mongoose.Schema({
  id: String, tenantId: String, exhibitionId: String,
  scannerCode: String,                // denormalized from the fixed "itemCode" field, for fast scan lookup
  fields: { type: mongoose.Schema.Types.Mixed, default: {} }, // dynamic per-tenant fields
  images: [String],                   // up to 3, named from the "imageCode" field: {code}, {code}_1, {code}_2
  active: { type: Boolean, default: true },
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const partySchema = new mongoose.Schema({
  id: String, tenantId: String,
  firmName: String, contactPerson: String, phone: String, email: String,
  cardImageUrl: String,
  source: { type: String, default: 'manual' }, // manual | scanned
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const orderSchema = new mongoose.Schema({
  id: String, orderNo: String, tenantId: String, exhibitionId: String,
  partyId: String, partyName: String, partyPhone: String,
  staffId: String, staffName: String,
  items: Array,                       // [{itemId, label, scannerCode, images, qty, extra}]
  remark: String,
  // Snapshot of the tenant's Order Form config at the time this order was
  // placed, plus the computed per-field totals — kept on the order so it
  // still renders correctly even if the admin changes the config later.
  orderFieldsSnapshot: { type: [{ key: String, label: String, unit: String, showTotal: Boolean }], default: [] },
  fieldTotals: { type: mongoose.Schema.Types.Mixed, default: {} },
  showImages: { type: Boolean, default: true },
  status: { type: String, default: 'pending' }, // pending | confirmed | cancelled
  shareToken: { type: String, unique: true, sparse: true },
  createdAt: { type: String, default: () => new Date().toISOString() },
});

// Audit trail — persisted separately from app logs. App logs (stdout, via
// logger.js) are for debugging and don't outlive a Render restart. This
// collection is for "who did what, when" accountability and must survive.
// Deliberately schema-light (Mixed `changes`) so any route can log any shape
// of before/after without a migration.
const auditLogSchema = new mongoose.Schema({
  id: String, tenantId: String,
  actorId: String, actorName: String, actorRole: String,
  action: String,                     // e.g. 'staff.create', 'item.delete', 'order.status_change'
  entityType: String, entityId: String,
  changes: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: String,
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const exhibitionSchema = new mongoose.Schema({
  id: String, tenantId: String,
  name: String, location: String, startDate: String, endDate: String,
  active: { type: Boolean, default: true },
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const Tenant     = mongoose.model('Tenant', tenantSchema);
const User       = mongoose.model('User', userSchema);
const FieldDef   = mongoose.model('FieldDef', fieldDefSchema);
const Item       = mongoose.model('Item', itemSchema);
const Party      = mongoose.model('Party', partySchema);
const Order      = mongoose.model('Order', orderSchema);
const Exhibition = mongoose.model('Exhibition', exhibitionSchema);
const AuditLog    = mongoose.model('AuditLog', auditLogSchema);

// ── DB INIT ───────────────────────────────────────────────────────────────────
let db = null;
let useMongoose = false;

async function connectDB() {
  if (MONGO_URI) {
    await mongoose.connect(MONGO_URI);
    useMongoose = true;
    log.info('MongoDB connected');
  } else {
    const low      = require('lowdb');
    const FileSync = require('lowdb/adapters/FileSync');
    const dbDir    = path.join(__dirname, 'db');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const adapter  = new FileSync(path.join(dbDir, 'db.json'));
    db = low(adapter);
    db.defaults({ tenants: [], users: [], fielddefs: [], items: [], parties: [], orders: [], exhibitions: [], auditlogs: [] }).write();
    log.warn('Using local JSON db (set MONGO_URI to use MongoDB)');
  }
}

// ── DB LAYER — one small factory instead of hand-rolling find/create/update/remove per collection ──
function makeCollectionOps(Model, lowdbKey, defaultSort) {
  return {
    async find(q = {}) {
      if (useMongoose) {
        let c = Model.find(q);
        if (defaultSort) c = c.sort(defaultSort);
        return c.lean();
      }
      let c = db.get(lowdbKey).filter(q);
      if (defaultSort) {
        const [key, dir] = Object.entries(defaultSort)[0];
        c = c.orderBy(key, dir === 1 ? 'asc' : 'desc');
      }
      return c.value();
    },
    async findOne(q) { return useMongoose ? Model.findOne(q).lean() : db.get(lowdbKey).find(q).value(); },
    async count(q = {}) { return useMongoose ? Model.countDocuments(q) : db.get(lowdbKey).filter(q).size().value(); },
    async create(doc) { if (useMongoose) await Model.create(doc); else db.get(lowdbKey).push(doc).write(); return doc; },
    async update(q, u) { if (useMongoose) await Model.updateOne(q, { $set: u }); else db.get(lowdbKey).find(q).assign(u).write(); },
    async remove(q) { if (useMongoose) await Model.deleteMany(q); else db.get(lowdbKey).remove(q).write(); },
  };
}

const TenantDB     = makeCollectionOps(Tenant, 'tenants');
const UserDB       = makeCollectionOps(User, 'users');
const FieldDefDB   = makeCollectionOps(FieldDef, 'fielddefs', { order: 1 });
const ItemDB       = makeCollectionOps(Item, 'items', { createdAt: -1 });
const PartyDB      = makeCollectionOps(Party, 'parties', { createdAt: -1 });
const OrderDB      = makeCollectionOps(Order, 'orders', { createdAt: -1 });
const ExhibitionDB = makeCollectionOps(Exhibition, 'exhibitions', { createdAt: -1 });
const AuditLogDB   = makeCollectionOps(AuditLog, 'auditlogs', { createdAt: -1 });

// Fire-and-forget audit write — never let a logging failure break the
// request that triggered it. Call this AFTER the mutation succeeds, with
// req so we can pull actor + tenant + IP consistently everywhere.
function logAudit(req, action, entityType, entityId, changes = null) {
  const entry = {
    id: uuid(), tenantId: req.tenant?.id || '',
    actorId: req.user?.id || '', actorName: req.user?.name || '', actorRole: req.user?.role || '',
    action, entityType, entityId: String(entityId || ''),
    changes, ip: req.ip, createdAt: new Date().toISOString(),
  };
  AuditLogDB.create(entry).catch(err => log.error({ err, action }, 'Failed to write audit log'));
}

// Every new company starts with just these two built-in fields — admin adds
// whatever else they need from the field builder. Both are permanent: Item
// Code is always the scan/barcode value, Image Code always drives which
// photos attach to the item (see makeItemImageUploader below).
const FIXED_FIELDS = [
  { key: 'itemCode',  label: 'Item Code',  type: 'text', isScannerKey: true, fixed: true },
  { key: 'imageCode', label: 'Image Code', type: 'text', isScannerKey: false, fixed: true },
];
const RESERVED_FIELD_LABELS = FIXED_FIELDS.map(f => f.label.toLowerCase());

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.set('trust proxy', true); // Render sits behind a proxy — needed for req.ip to be the real client IP
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging — one line per request, written after the response finishes
// so it can include status + duration. Placed early so it wraps every route,
// but customProps reads req.tenant/req.user which are set later in the chain
// by resolveTenant/auth — safe because this only runs (and reads them) at
// response-finish time, by which point those middlewares have already run.
app.use(pinoHttp({
  logger: log,
  customProps: (req) => ({ tenant: req.tenant?.slug, userId: req.user?.id, role: req.user?.role }),
  // Don't spam logs at info level for routine health checks
  customLogLevel: (req, res, err) => {
    if (req.url === '/api/ping') return 'silent';
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  redact: ['req.headers.authorization', 'req.body.password', 'req.body.newPassword'],
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/api/ping', (req, res) => res.send('exhibition-order-saas OK'));

// Resolves the company (tenant) for every /api/* call from, in priority order:
// explicit header/query (used by the frontend + during local dev without subdomains),
// then the request's subdomain (kaashvi.orders.is -> slug "kaashvi") in production.
// Shared hosting platforms hand out <service>.onrender.com-style URLs that are
// structurally identical to a real per-company subdomain — skip those known
// platform hosts so a Render/Vercel/etc. deployment isn't mistaken for a tenant.
const PLATFORM_HOST_SUFFIXES = ['onrender.com', 'vercel.app', 'netlify.app', 'herokuapp.com'];
async function resolveTenant(req, res, next) {
  let slug = req.headers['x-tenant-slug'] || req.query.tenant;
  if (!slug) {
    const host = (req.hostname || '').toLowerCase();
    const onPlatformHost = PLATFORM_HOST_SUFFIXES.some(suf => host.endsWith(suf)) || host === 'localhost';
    const parts = host.split('.');
    if (!onPlatformHost && parts.length > 2 && parts[0] !== 'www') slug = parts[0];
  }
  if (!slug) return res.status(400).json({ error: 'Company not specified. Use the company subdomain, or pass ?tenant=slug / X-Tenant-Slug header.' });
  const tenant = await TenantDB.findOne({ slug: String(slug).toLowerCase() });
  if (!tenant) return res.status(404).json({ error: `No company found for "${slug}"` });
  req.tenant = tenant;
  next();
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (req.tenant && payload.tenantId !== req.tenant.id)
      return res.status(401).json({ error: 'Token does not belong to this company' });
    req.user = payload;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    next();
  };
}

// ── IMAGE UPLOAD: R2 with local disk fallback ────────────────────────────────
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
function imageFilter(_req, file, cb) {
  if (/image\/(jpeg|png|webp)/.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only JPG, PNG or WebP images allowed'));
}
function makeUploader(keyPrefix, localDir) {
  if (useR2) {
    const storage = multerS3({
      s3: s3Client, bucket: R2_BUCKET, contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (_req, file, cb) => {
        const ext = (file.originalname.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase();
        cb(null, `${keyPrefix}/${uuid()}${ext}`);
      },
    });
    return multer({ storage, limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFilter });
  }
  const dest = path.join(__dirname, 'uploads', localDir);
  fs.mkdirSync(dest, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _f, cb) => cb(null, dest),
      filename: (_req, file, cb) => {
        const ext = (file.originalname.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase();
        cb(null, uuid() + ext);
      },
    }),
    limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFilter,
  });
}
function fileUrl(file, localDir) {
  return useR2 ? `${R2_PUBLIC_URL}/${file.key}` : `/uploads/${localDir}/${file.filename}`;
}

// Item photos are named from the item's Image Code, not a random id: code "DZ1"
// with startIndex 0 produces DZ1.jpg, DZ1_1.jpg, DZ1_2.jpg — matching ecatlog's
// image-naming convention, capped at 3 images per item.
const IMAGE_SLOT_SUFFIXES = ['', '_1', '_2'];
function makeItemImageUploader(tenantId, imageCode, startIndex) {
  let slot = startIndex;
  const nameFor = ext => `${imageCode}${IMAGE_SLOT_SUFFIXES[slot++] ?? '_' + slot}${ext}`;
  if (useR2) {
    const storage = multerS3({
      s3: s3Client, bucket: R2_BUCKET, contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (_req, file, cb) => {
        const ext = (file.originalname.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase();
        cb(null, `exo/${tenantId}/items/${nameFor(ext)}`);
      },
    });
    return multer({ storage, limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFilter });
  }
  const dest = path.join(__dirname, 'uploads', 'images', tenantId);
  fs.mkdirSync(dest, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _f, cb) => cb(null, dest),
      filename: (_req, file, cb) => {
        const ext = (file.originalname.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase();
        cb(null, nameFor(ext));
      },
    }),
    limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFilter,
  });
}

// ── SLUG VALIDATION (same reserved-word + format checks ecatlog uses for storeSlug) ──
const RESERVED_SLUGS = ['www','api','app','admin','static','support','mail','ftp','login','signup','settings','assets','uploads','order','orders'];
function normalizeSlug(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function validateSlug(slug) {
  if (slug.length < 3 || slug.length > 30) return 'Company link name must be 3-30 characters (letters, numbers, hyphens).';
  if (RESERVED_SLUGS.includes(slug)) return 'That name is reserved. Please choose another.';
  return null;
}

// ── COMPANY REGISTRATION ──────────────────────────────────────────────────────
app.get('/api/companies/check-slug', async (req, res) => {
  const slug = normalizeSlug(req.query.slug);
  const err = validateSlug(slug);
  if (err) return res.json({ available: false, slug, error: err });
  const clash = await TenantDB.findOne({ slug });
  res.json({ available: !clash, slug });
});

app.post('/api/companies/register', async (req, res) => {
  const { companyName, slug: rawSlug, adminName, email, password, phone } = req.body;
  if (!companyName || !rawSlug || !adminName || !email || !password)
    return res.status(400).json({ error: 'All fields are required' });
  const slug = normalizeSlug(rawSlug);
  const err = validateSlug(slug);
  if (err) return res.status(400).json({ error: err });
  if (await TenantDB.findOne({ slug })) return res.status(400).json({ error: 'That company link name is already taken' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const tenant = { id: uuid(), name: companyName, slug, plan: 'free', createdAt: new Date().toISOString() };
  await TenantDB.create(tenant);

  for (let i = 0; i < FIXED_FIELDS.length; i++) {
    await FieldDefDB.create({ id: uuid(), tenantId: tenant.id, order: i, active: true, options: [], createdAt: new Date().toISOString(), ...FIXED_FIELDS[i] });
  }

  const admin = {
    id: uuid(), tenantId: tenant.id, role: 'admin', loginId: email.toLowerCase(),
    password: bcrypt.hashSync(password, 10), name: adminName, phone: phone || '', email,
    active: true, createdAt: new Date().toISOString(),
  };
  await UserDB.create(admin);

  const token = jwt.sign({ id: admin.id, tenantId: tenant.id, role: admin.role, loginId: admin.loginId, name: admin.name }, JWT_SECRET, { expiresIn: '7d' });
  const { password: _pw, ...safeAdmin } = admin;
  res.json({ token, user: safeAdmin, tenant });
});

// ── AUTH (tenant-scoped: resolved from subdomain / header / ?tenant=) ───────
app.post('/api/auth/login', resolveTenant, async (req, res) => {
  const { loginId, password } = req.body;
  if (!loginId || !password) return res.status(400).json({ error: 'Login ID and password are required' });
  const user = await UserDB.findOne({ tenantId: req.tenant.id, loginId: String(loginId).toLowerCase() });
  if (!user || !user.active || !bcrypt.compareSync(password, user.password)) {
    log.warn({ tenant: req.tenant.slug, loginId, ip: req.ip }, 'Failed login attempt');
    return res.status(401).json({ error: 'Invalid login ID or password' });
  }
  const token = jwt.sign({ id: user.id, tenantId: req.tenant.id, role: user.role, loginId: user.loginId, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  const { password: _pw, ...safeUser } = user;
  req.user = safeUser; // so logAudit can pick up actor info for this request
  logAudit(req, 'auth.login', 'user', user.id);
  res.json({ token, user: safeUser, tenant: req.tenant });
});

// Client self-signup — exhibition buyers create their own login within a company
app.post('/api/auth/register-client', resolveTenant, async (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ error: 'Name, phone and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const loginId = (email || phone).toLowerCase();
  if (await UserDB.findOne({ tenantId: req.tenant.id, loginId }))
    return res.status(400).json({ error: 'An account already exists for that email/phone with this company' });
  const client = {
    id: uuid(), tenantId: req.tenant.id, role: 'client', loginId,
    password: bcrypt.hashSync(password, 10), name, phone, email: email || '',
    active: true, createdAt: new Date().toISOString(),
  };
  await UserDB.create(client);
  const token = jwt.sign({ id: client.id, tenantId: req.tenant.id, role: client.role, loginId: client.loginId, name: client.name }, JWT_SECRET, { expiresIn: '7d' });
  const { password: _pw, ...safeClient } = client;
  res.json({ token, user: safeClient, tenant: req.tenant });
});

// Staff accounts are never self-signed-up — the admin creates them internally
app.post('/api/staff', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const loginId = (email || phone || name).toLowerCase();
  if (await UserDB.findOne({ tenantId: req.tenant.id, loginId }))
    return res.status(400).json({ error: 'That login ID is already in use' });
  const staff = {
    id: uuid(), tenantId: req.tenant.id, role: 'staff', loginId,
    password: bcrypt.hashSync(password, 10), name, phone: phone || '', email: email || '',
    active: true, createdAt: new Date().toISOString(),
  };
  await UserDB.create(staff);
  logAudit(req, 'staff.create', 'user', staff.id, { name: staff.name, loginId: staff.loginId });
  const { password: _pw, ...safeStaff } = staff;
  res.json(safeStaff);
});

app.get('/api/staff', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const staff = await UserDB.find({ tenantId: req.tenant.id, role: 'staff' });
  res.json(staff.map(({ password: _pw, ...s }) => s));
});

app.put('/api/staff/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const staffUser = await UserDB.findOne({ id: req.params.id, tenantId: req.tenant.id, role: 'staff' });
  if (!staffUser) return res.status(404).json({ error: 'Staff member not found' });
  const updates = {};
  ['name', 'phone', 'email', 'active'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (req.body.newPassword) {
    if (req.body.newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 characters' });
    updates.password = bcrypt.hashSync(req.body.newPassword, 10);
  }
  await UserDB.update({ id: req.params.id }, updates);
  logAudit(req, 'staff.update', 'user', req.params.id, { fields: Object.keys(updates) });
  res.json({ ok: true });
});

app.delete('/api/staff/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  await UserDB.remove({ id: req.params.id, tenantId: req.tenant.id, role: 'staff' });
  logAudit(req, 'staff.delete', 'user', req.params.id);
  res.json({ ok: true });
});

app.get('/api/me', resolveTenant, auth, async (req, res) => {
  const user = await UserDB.findOne({ id: req.user.id });
  if (!user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  const { password: _pw, ...safeUser } = user;
  res.json({ ...safeUser, tenant: req.tenant });
});

app.put('/api/companies/settings', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const updates = {};
  ['name'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  await TenantDB.update({ id: req.tenant.id }, updates);
  logAudit(req, 'company.settings_update', 'tenant', req.tenant.id, updates);
  res.json({ ok: true });
});

// Which item fields show up per line on the order link, and which get summed
// into a total — validated against the tenant's real fields so a stale/typo'd
// key can't sneak in.
app.put('/api/companies/order-fields', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const list = Array.isArray(req.body.orderFields) ? req.body.orderFields : [];
  const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
  const byKey = {}; fieldDefs.forEach(f => { byKey[f.key] = f; });
  // Label/unit are pulled fresh from the real field def rather than trusting
  // the client, so they can't drift out of sync with the field builder.
  const orderFields = list
    .filter(f => f && byKey[f.key])
    .map(f => ({ key: f.key, label: byKey[f.key].label, unit: byKey[f.key].unit || '', showTotal: !!f.showTotal }));
  const orderShowImages = req.body.showImages !== undefined ? !!req.body.showImages : true;
  await TenantDB.update({ id: req.tenant.id }, { orderFields, orderShowImages });
  res.json({ ok: true, orderFields, orderShowImages });
});

app.post('/api/companies/logo', resolveTenant, auth, requireRole('admin'), (req, res) => {
  const uploader = makeUploader(`exo/${req.tenant.id}/logo`, path.join('logos', req.tenant.id));
  uploader.single('logo')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Logo too large (max 10MB)' : err.message });
    const logoUrl = fileUrl(req.file, path.join('logos', req.tenant.id));
    await TenantDB.update({ id: req.tenant.id }, { logoUrl });
    res.json({ ok: true, logoUrl });
  });
});

// ── ITEM MASTER FIELD DEFINITIONS — the "10-12 fields, add/delete, customer-wise" builder ──
app.get('/api/fields', resolveTenant, auth, async (req, res) => {
  const fields = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
  res.json(fields);
});

app.post('/api/fields', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const { label, type, options, decimals, unit } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'Field label is required' });
  if (RESERVED_FIELD_LABELS.includes(label.trim().toLowerCase()))
    return res.status(400).json({ error: `"${label.trim()}" is a built-in field already on every item` });
  const key = normalizeSlug(label).replace(/-/g, '_') || uuid().slice(0, 8);
  if (await FieldDefDB.findOne({ tenantId: req.tenant.id, key, active: true }))
    return res.status(400).json({ error: 'A field with a similar name already exists' });
  const existing = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
  const field = {
    id: uuid(), tenantId: req.tenant.id, key, label: label.trim(),
    type: type || 'text', options: Array.isArray(options) ? options : [],
    decimals: type === 'number' ? Math.max(0, Math.min(6, Number(decimals) || 0)) : 2,
    unit: type === 'number' ? String(unit || '').trim() : '',
    order: existing.length, isScannerKey: false, fixed: false, active: true, createdAt: new Date().toISOString(),
  };
  await FieldDefDB.create(field);
  res.json(field);
});

app.put('/api/fields/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const field = await FieldDefDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!field) return res.status(404).json({ error: 'Field not found' });
  const updates = {};
  if (req.body.label !== undefined && req.body.label.trim()) updates.label = req.body.label.trim();
  if (req.body.options !== undefined) updates.options = req.body.options;
  if (req.body.order !== undefined) updates.order = req.body.order;
  if (req.body.type !== undefined && !field.fixed) updates.type = req.body.type; // fixed fields always stay text
  if (req.body.decimals !== undefined) updates.decimals = Math.max(0, Math.min(6, Number(req.body.decimals) || 0));
  if (req.body.unit !== undefined) updates.unit = String(req.body.unit).trim();
  await FieldDefDB.update({ id: req.params.id }, updates);
  res.json({ ok: true });
});

// Swaps this field's order with its neighbor — used by the ↑/↓ buttons in the field builder
app.put('/api/fields/:id/move', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const list = await FieldDefDB.find({ tenantId: req.tenant.id, active: true }); // sorted by order
  const idx = list.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Field not found' });
  const swapIdx = req.body.direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return res.json({ ok: true }); // already at the edge
  // Snapshot both ids/orders as primitives before writing — the lowdb dev
  // fallback returns live object references from find(), so mutating one via
  // update() would otherwise silently corrupt the other's captured order too.
  const aId = list[idx].id, aOrder = list[idx].order;
  const bId = list[swapIdx].id, bOrder = list[swapIdx].order;
  await FieldDefDB.update({ id: aId }, { order: bOrder });
  await FieldDefDB.update({ id: bId }, { order: aOrder });
  res.json({ ok: true });
});

// Soft-delete — keeps historical items readable even after a field is removed from the builder.
// The two built-in fields (Item Code, Image Code) can never be deleted.
app.delete('/api/fields/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const field = await FieldDefDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!field) return res.status(404).json({ error: 'Field not found' });
  if (field.fixed) return res.status(400).json({ error: `"${field.label}" is a built-in field and can't be deleted` });
  await FieldDefDB.update({ id: req.params.id }, { active: false });
  res.json({ ok: true });
});

// ── ITEMS ─────────────────────────────────────────────────────────────────────
// Item Code is always the scan/barcode value — no per-tenant configuration needed.
// Normalized to uppercase so scanning/typing "dz1", "Dz1" or "DZ1" all match
// the same item, whichever case the code was originally entered in.
function scannerCodeOf(fields) {
  return String(fields?.itemCode ?? '').trim().toUpperCase();
}

// Rounds number-type field values to that field's configured decimal places —
// applied on manual save and bulk import alike, so a field's precision is a
// real constraint rather than just a display hint. Also uppercases Item Code
// so the displayed value always matches the (uppercased) scannerCode used for
// lookup — one normalization point instead of two representations drifting.
function normalizeFieldValues(fieldDefs, rawFields) {
  const out = {};
  for (const [key, val] of Object.entries(rawFields || {})) {
    const def = fieldDefs.find(f => f.key === key);
    if (key === 'itemCode' && val !== '' && val !== null && val !== undefined) {
      out[key] = String(val).trim().toUpperCase();
    } else if (def?.type === 'number' && val !== '' && val !== null && val !== undefined) {
      const n = Number(val);
      out[key] = isNaN(n) ? val : Number(n.toFixed(def.decimals ?? 2));
    } else {
      out[key] = val;
    }
  }
  return out;
}

app.get('/api/items', resolveTenant, auth, async (req, res) => {
  const q = { tenantId: req.tenant.id, active: true };
  if (req.query.exhibitionId) q.exhibitionId = req.query.exhibitionId;
  let items = await ItemDB.find(q);
  if (req.query.q) {
    const needle = String(req.query.q).toLowerCase();
    items = items.filter(it =>
      it.scannerCode?.toLowerCase().includes(needle) ||
      Object.values(it.fields || {}).some(v => String(v).toLowerCase().includes(needle))
    );
  }
  res.json(items);
});

app.get('/api/items/scan/:code', resolveTenant, auth, async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const item = await ItemDB.findOne({ tenantId: req.tenant.id, scannerCode: code, active: true });
  if (!item) return res.status(404).json({ error: `No item found for code "${req.params.code}"` });
  res.json(item);
});

app.post('/api/items', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const { fields: rawFields, exhibitionId } = req.body;
  if (!rawFields || typeof rawFields !== 'object') return res.status(400).json({ error: 'fields object is required' });
  const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
  const fields = normalizeFieldValues(fieldDefs, rawFields);
  const scannerCode = scannerCodeOf(fields);
  if (scannerCode && await ItemDB.findOne({ tenantId: req.tenant.id, scannerCode, active: true }))
    return res.status(400).json({ error: `An item with scanner code "${scannerCode}" already exists` });
  const item = {
    id: uuid(), tenantId: req.tenant.id, exhibitionId: exhibitionId || '',
    scannerCode, fields, images: [], active: true, createdAt: new Date().toISOString(),
  };
  await ItemDB.create(item);
  res.json(item);
});

app.put('/api/items/:id', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const item = await ItemDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const updates = {};
  if (req.body.exhibitionId !== undefined) updates.exhibitionId = req.body.exhibitionId;
  if (req.body.fields) {
    const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
    updates.fields = { ...item.fields, ...normalizeFieldValues(fieldDefs, req.body.fields) };
    updates.scannerCode = scannerCodeOf(updates.fields);
  }
  await ItemDB.update({ id: req.params.id }, updates);
  res.json({ ok: true });
});

app.delete('/api/items/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  await ItemDB.update({ id: req.params.id, tenantId: req.tenant.id }, { active: false });
  logAudit(req, 'item.delete', 'item', req.params.id);
  res.json({ ok: true });
});

// Photos are named from the item's Image Code (see makeItemImageUploader) —
// the field must be set first, and each item is capped at 3 photos total.
app.post('/api/items/:id/images', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const item = await ItemDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const imageCode = String(item.fields?.imageCode || '').trim();
  if (!imageCode) return res.status(400).json({ error: 'Set the Image Code field on this item before uploading photos' });
  const existingCount = (item.images || []).length;
  if (existingCount >= 3) return res.status(400).json({ error: 'This item already has the maximum of 3 photos — remove one first' });

  const remaining = 3 - existingCount;
  const localDir = path.join('images', req.tenant.id);
  const uploader = makeItemImageUploader(req.tenant.id, imageCode, existingCount);
  uploader.array('images', remaining)(req, res, async err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large (max 10MB)' });
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `Only ${remaining} more photo(s) fit (max 3 total) — select fewer files` });
      return res.status(400).json({ error: err.message });
    }
    const newUrls = req.files.map(f => fileUrl(f, localDir));
    const images = [...(item.images || []), ...newUrls];
    await ItemDB.update({ id: item.id }, { images });
    res.json({ ok: true, images });
  });
});

// Removes one photo (by its position in the images array) to free up a slot
app.delete('/api/items/:id/images/:index', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const item = await ItemDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const idx = Number(req.params.index);
  const images = (item.images || []).filter((_, i) => i !== idx);
  await ItemDB.update({ id: item.id }, { images });
  res.json({ ok: true, images });
});

// ── BULK IMAGE IMPORT ─────────────────────────────────────────────────────────
// Upload a whole folder of pre-named photos at once (e.g. from a phone/camera
// dump) — each file is matched to an item purely by filename, using the same
// {code}/{code}_1/{code}_2 convention as the single-item uploader. Files land
// in memory first since a single batch can span many different items, each
// needing its own destination key — makeItemImageUploader's disk/S3 storage
// engines assume one item per request, so this route writes files manually.
const bulkImageUploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFilter });

function parseImageFilename(originalname) {
  const ext = (originalname.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase();
  const base = originalname.slice(0, originalname.length - ext.length);
  const m = base.match(/^(.*)_([12])$/);
  return { code: (m ? m[1] : base).trim(), slot: m ? Number(m[2]) : 0, ext };
}

app.post('/api/items/bulk-images', resolveTenant, auth, requireRole('admin', 'staff'), (req, res) => {
  bulkImageUploader.array('images', 300)(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those images is too large (max 10MB each)' : err.message });
    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

    const items = await ItemDB.find({ tenantId: req.tenant.id, active: true });
    const byCode = {};
    items.forEach(it => { const code = String(it.fields?.imageCode || '').trim(); if (code) byCode[code] = it; });

    const groups = {};
    req.files.forEach(file => {
      const { code, slot, ext } = parseImageFilename(file.originalname);
      (groups[code] ??= []).push({ file, slot, ext });
    });

    let matched = 0, unmatchedCode = 0, full = 0;
    for (const code of Object.keys(groups)) {
      const item = byCode[code];
      const candidates = groups[code].sort((a, b) => a.slot - b.slot);
      if (!item) { unmatchedCode += candidates.length; continue; }

      const images = [...(item.images || [])];
      for (const c of candidates) {
        if (images.length >= 3) { full++; continue; }
        const filename = `${code}${IMAGE_SLOT_SUFFIXES[images.length]}${c.ext}`;
        if (useR2) {
          const key = `exo/${req.tenant.id}/items/${filename}`;
          await s3Client.send(new S3PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: c.file.buffer, ContentType: c.file.mimetype }));
          images.push(`${R2_PUBLIC_URL}/${key}`);
        } else {
          const dest = path.join(__dirname, 'uploads', 'images', req.tenant.id);
          fs.mkdirSync(dest, { recursive: true });
          fs.writeFileSync(path.join(dest, filename), c.file.buffer);
          images.push(`/uploads/images/${req.tenant.id}/${filename}`);
        }
        matched++;
      }
      await ItemDB.update({ id: item.id }, { images });
    }
    res.json({ ok: true, totalFiles: req.files.length, matched, unmatchedCode, full });
  });
});

// ── EXCEL TEMPLATE / BULK IMPORT / EXPORT ─────────────────────────────────────
// Columns match the tenant's own Item Master fields (whatever the admin has
// configured), so the template always lines up with what /admin/item-master.html
// can render. auth() also accepts ?token=, so a plain download link works.
function fieldTypeDescription(f) {
  if (f.type === 'number') { const d = f.decimals ?? 2; return `Number, ${d} decimal${d === 1 ? '' : 's'}`; }
  if (f.type === 'date') return 'Date';
  if (f.type === 'dropdown') return 'Dropdown';
  return 'Text';
}
function fieldHeaderLabel(f) {
  return `${f.label} (${fieldTypeDescription(f)})${f.isScannerKey ? ' *' : ''}`;
}
// Recovers the plain field label from a header cell like "Price (Number, 2 decimals) *"
function baseLabelFromHeader(header) {
  return header.replace(/\s*\*\s*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

const bulkUploader = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => { const d = path.join(__dirname, 'uploads', 'bulk'); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, file, cb) => cb(null, uuid() + path.extname(file.originalname)),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.get('/api/items/template/excel', resolveTenant, auth, async (req, res) => {
  try {
    const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
    const headers = fieldDefs.map(fieldHeaderLabel);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    ws['!cols'] = headers.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Item Master');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Item_Master_Template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/items/export/excel', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  try {
    const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
    const headers = fieldDefs.map(fieldHeaderLabel);
    const items = await ItemDB.find({ tenantId: req.tenant.id, active: true });
    const rows = items.map(it => fieldDefs.map(f => it.fields?.[f.key] ?? ''));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = headers.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Items_Export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/items/import/excel', resolveTenant, auth, requireRole('admin', 'staff'), (req, res) => {
  bulkUploader.single('file')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10MB)' : err.message });
    if (!req.file) return res.status(400).json({ error: 'File is required' });
    try {
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      fs.unlink(req.file.path, () => {});

      const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
      const labelToKey = {};
      fieldDefs.forEach(f => { labelToKey[f.label.trim().toLowerCase()] = f.key; });
      const scannerField = fieldDefs.find(f => f.isScannerKey);

      let created = 0, updated = 0, skipped = 0;
      for (const row of rows) {
        const rawFields = {};
        Object.keys(row).forEach(header => {
          const key = labelToKey[baseLabelFromHeader(header)];
          if (key && row[header] !== '') rawFields[key] = row[header];
        });
        const fields = normalizeFieldValues(fieldDefs, rawFields);
        const scannerCode = scannerField ? String(fields[scannerField.key] || '').trim() : '';
        if (!scannerCode) { skipped++; continue; }
        const existing = await ItemDB.findOne({ tenantId: req.tenant.id, scannerCode, active: true });
        if (existing) {
          await ItemDB.update({ id: existing.id }, { fields: { ...existing.fields, ...fields } });
          updated++;
        } else {
          await ItemDB.create({ id: uuid(), tenantId: req.tenant.id, exhibitionId: '', scannerCode, fields, images: [], active: true, createdAt: new Date().toISOString() });
          created++;
        }
      }
      res.json({ ok: true, created, updated, skipped, total: rows.length });
    } catch (err) { res.status(500).json({ error: 'Could not read that file — please use the template format. (' + err.message + ')' }); }
  });
});

// ── VISITING CARD OCR ─────────────────────────────────────────────────────────
// Best-effort autofill only — staff always reviews/edits the guess before saving
// the party. Uses Google Cloud Vision's TEXT_DETECTION REST endpoint when
// OCR_API_KEY is set; otherwise returns empty fields for manual entry.
function callVisionApi(base64Image) {
  const payload = JSON.stringify({ requests: [{ image: { content: base64Image }, features: [{ type: 'TEXT_DETECTION' }] }] });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'vision.googleapis.com',
      path: `/v1/images:annotate?key=${process.env.OCR_API_KEY}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, resp => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => resp.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`Vision API ${resp.statusCode}: ${data}`)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
function parseCardText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const phoneMatch = text.match(/(\+?\d[\d\s-]{8,}\d)/);
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return {
    firmName: lines[0] || '',
    contactPerson: lines[1] || '',
    phone: phoneMatch ? phoneMatch[1].replace(/\s+/g, '') : '',
    email: emailMatch ? emailMatch[0] : '',
  };
}
async function runVisitingCardOcr(base64Image) {
  if (!process.env.OCR_API_KEY) return { firmName: '', contactPerson: '', phone: '', email: '' };
  try {
    const result = await callVisionApi(base64Image);
    const text = result?.responses?.[0]?.fullTextAnnotation?.text || '';
    return parseCardText(text);
  } catch (e) {
    log.error({ err: e }, 'OCR Vision API call failed');
    return { firmName: '', contactPerson: '', phone: '', email: '' };
  }
}

// ── PARTIES (exhibition visitors / buyers) ────────────────────────────────────
app.post('/api/parties/scan-card', resolveTenant, auth, requireRole('admin', 'staff'), (req, res) => {
  const localDir = path.join('cards', req.tenant.id);
  const uploader = makeUploader(`exo/${req.tenant.id}/cards`, localDir);
  uploader.single('card')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Image too large (max 10MB)' : err.message });
    if (!req.file) return res.status(400).json({ error: 'Visiting card image is required' });
    const cardImageUrl = fileUrl(req.file, localDir);
    const base64 = useR2
      ? Buffer.from(await (await fetch(cardImageUrl)).arrayBuffer()).toString('base64')
      : fs.readFileSync(req.file.path).toString('base64');
    const guess = await runVisitingCardOcr(base64);
    res.json({ cardImageUrl, guess });
  });
});

app.post('/api/parties', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const { firmName, contactPerson, phone, email, cardImageUrl, source } = req.body;
  if (!firmName || !phone) return res.status(400).json({ error: 'Firm name and phone are required' });
  const party = {
    id: uuid(), tenantId: req.tenant.id, firmName, contactPerson: contactPerson || '',
    phone, email: email || '', cardImageUrl: cardImageUrl || '',
    source: source === 'scanned' ? 'scanned' : 'manual', createdAt: new Date().toISOString(),
  };
  await PartyDB.create(party);
  res.json(party);
});

app.get('/api/parties', resolveTenant, auth, async (req, res) => {
  let parties = await PartyDB.find({ tenantId: req.tenant.id });
  if (req.query.q) {
    const needle = String(req.query.q).toLowerCase();
    parties = parties.filter(p => p.firmName?.toLowerCase().includes(needle) || p.phone?.includes(needle));
  }
  res.json(parties);
});

app.get('/api/parties/:id', resolveTenant, auth, async (req, res) => {
  const party = await PartyDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!party) return res.status(404).json({ error: 'Party not found' });
  res.json(party);
});

// ── ORDERS ────────────────────────────────────────────────────────────────────
app.post('/api/orders', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const { partyId, exhibitionId, items, remark } = req.body;
  if (!partyId || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'partyId and at least one item are required' });
  const party = await PartyDB.findOne({ id: partyId, tenantId: req.tenant.id });
  if (!party) return res.status(404).json({ error: 'Party not found' });

  // No built-in "price" concept — every value on an order (price, weight,
  // whatever) is just a regular Item Master field, shown per the tenant's
  // Order Form config below. Qty is the only quantity that's always tracked.
  const orderFields = req.tenant.orderFields || [];
  const lineItems = [];
  for (const line of items) {
    const item = await ItemDB.findOne({ id: line.itemId, tenantId: req.tenant.id });
    if (!item) continue;
    const qty = Number(line.qty) || 1;
    const extra = {};
    orderFields.forEach(f => { extra[f.key] = item.fields?.[f.key] ?? ''; });
    lineItems.push({
      itemId: item.id, label: item.fields?.productName || item.scannerCode || item.id,
      scannerCode: item.scannerCode, images: item.images || [],
      qty, extra,
    });
  }
  if (!lineItems.length) return res.status(400).json({ error: 'No valid items in this order' });
  const fieldTotals = {};
  orderFields.filter(f => f.showTotal).forEach(f => {
    fieldTotals[f.key] = lineItems.reduce((sum, l) => sum + (Number(l.extra?.[f.key]) || 0) * l.qty, 0);
  });
  const orderCount = await OrderDB.count({ tenantId: req.tenant.id });

  const order = {
    id: uuid(), orderNo: `EX${1000 + orderCount + 1}`, tenantId: req.tenant.id,
    exhibitionId: exhibitionId || '', partyId, partyName: party.firmName, partyPhone: party.phone,
    staffId: req.user.id, staffName: req.user.name,
    items: lineItems, remark: remark || '', status: 'pending',
    orderFieldsSnapshot: orderFields, fieldTotals,
    showImages: req.tenant.orderShowImages !== false,
    shareToken: uuid(), createdAt: new Date().toISOString(),
  };
  await OrderDB.create(order);
  logAudit(req, 'order.create', 'order', order.id, { orderNo: order.orderNo, partyId, itemCount: lineItems.length });
  res.json({ ...order, shareUrl: `${APP_URL}/order/${order.shareToken}` });
});

app.get('/api/orders', resolveTenant, auth, async (req, res) => {
  const q = { tenantId: req.tenant.id };
  if (req.query.partyId) q.partyId = req.query.partyId;
  if (req.query.exhibitionId) q.exhibitionId = req.query.exhibitionId;
  if (req.query.status) q.status = req.query.status;
  if (req.user.role === 'staff') q.staffId = req.user.id;
  if (req.user.role === 'client') {
    const user = await UserDB.findOne({ id: req.user.id });
    const party = await PartyDB.findOne({ tenantId: req.tenant.id, phone: user.phone });
    q.partyId = party ? party.id : '__none__';
  }
  const orders = await OrderDB.find(q);
  res.json(orders);
});

app.get('/api/orders/:id', resolveTenant, auth, async (req, res) => {
  const order = await OrderDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

app.put('/api/orders/:id/status', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const before = await OrderDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  await OrderDB.update({ id: req.params.id, tenantId: req.tenant.id }, { status });
  logAudit(req, 'order.status_change', 'order', req.params.id, { from: before?.status, to: status });
  res.json({ ok: true });
});

// Public — no auth, no tenant header required. shareToken is a random uuid so it
// doubles as the access secret; the order's own tenant is looked up from it so the
// client-facing page can render the company name/logo without logging in.
app.get('/api/orders/public/:token', async (req, res) => {
  const order = await OrderDB.findOne({ shareToken: req.params.token });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const tenant = await TenantDB.findOne({ id: order.tenantId });
  res.json({ order, company: { name: tenant?.name, logoUrl: tenant?.logoUrl } });
});

// ── EXHIBITIONS (optional grouping — one company can run several events) ─────
app.get('/api/exhibitions', resolveTenant, auth, async (req, res) => {
  res.json(await ExhibitionDB.find({ tenantId: req.tenant.id }));
});

app.post('/api/exhibitions', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const { name, location, startDate, endDate } = req.body;
  if (!name) return res.status(400).json({ error: 'Exhibition name is required' });
  const exhibition = {
    id: uuid(), tenantId: req.tenant.id, name, location: location || '',
    startDate: startDate || '', endDate: endDate || '', active: true, createdAt: new Date().toISOString(),
  };
  await ExhibitionDB.create(exhibition);
  res.json(exhibition);
});

app.put('/api/exhibitions/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const updates = {};
  ['name', 'location', 'startDate', 'endDate', 'active'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  await ExhibitionDB.update({ id: req.params.id, tenantId: req.tenant.id }, updates);
  res.json({ ok: true });
});

app.delete('/api/exhibitions/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  await ExhibitionDB.update({ id: req.params.id, tenantId: req.tenant.id }, { active: false });
  logAudit(req, 'exhibition.delete', 'exhibition', req.params.id);
  res.json({ ok: true });
});

// ── REPORTS ───────────────────────────────────────────────────────────────────
// Computed in application code (not a DB aggregation pipeline) so the same logic
// works identically against MongoDB and the lowdb fallback.
app.get('/api/reports/party-wise', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const orders = await OrderDB.find({ tenantId: req.tenant.id });
  const byParty = {};
  for (const o of orders) {
    const key = o.partyId;
    byParty[key] ??= { partyId: o.partyId, partyName: o.partyName, partyPhone: o.partyPhone, orderCount: 0 };
    byParty[key].orderCount += 1;
  }
  res.json(Object.values(byParty).sort((a, b) => b.orderCount - a.orderCount));
});

app.get('/api/reports/item-wise', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const orders = await OrderDB.find({ tenantId: req.tenant.id });
  const byItem = {};
  for (const o of orders) {
    for (const line of o.items || []) {
      byItem[line.itemId] ??= { itemId: line.itemId, label: line.label, scannerCode: line.scannerCode, qty: 0 };
      byItem[line.itemId].qty += line.qty;
    }
  }
  res.json(Object.values(byItem).sort((a, b) => b.qty - a.qty));
});

app.get('/api/reports/staff-wise', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const orders = await OrderDB.find({ tenantId: req.tenant.id });
  const byStaff = {};
  for (const o of orders) {
    byStaff[o.staffId] ??= { staffId: o.staffId, staffName: o.staffName, orderCount: 0 };
    byStaff[o.staffId].orderCount += 1;
  }
  res.json(Object.values(byStaff).sort((a, b) => b.orderCount - a.orderCount));
});

// Admin-only view into the audit trail — filter by tenant automatically,
// optionally narrow by entityType/action/actorId via query params.
app.get('/api/audit-log', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const q = { tenantId: req.tenant.id };
  if (req.query.entityType) q.entityType = req.query.entityType;
  if (req.query.action) q.action = req.query.action;
  if (req.query.actorId) q.actorId = req.query.actorId;
  const entries = await AuditLogDB.find(q);
  res.json(entries.slice(0, 500)); // simple cap — add real pagination if this grows large
});

// ── STATIC PAGES ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
// Public order-confirmation page — token is looked up client-side via /api/orders/public/:token
app.get('/order/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'order', 'view.html')));

// ── CENTRAL ERROR HANDLER ──────────────────────────────────────────────────────
// Express 5 auto-forwards rejected promises from async route handlers here, so
// this catches anything a route didn't handle itself with its own try/catch.
// Full error (with stack) goes to the log; the client only ever gets a generic
// message — never err.message, which can leak internals (DB names, file
// paths, library internals).
app.use((err, req, res, next) => {
  (req.log || log).error({ err }, 'Unhandled request error');
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' });
});

// Belt-and-suspenders: catch anything that escapes Express entirely (e.g. a
// throw inside a callback, not a route handler) so it's logged with a stack
// trace before Render restarts the process, instead of vanishing.
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception — process will exit');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled promise rejection');
});

connectDB().then(() => {
  initR2();
  app.listen(PORT, () => log.info({ port: PORT }, 'Exhibition Order SaaS running'));
}).catch(err => {
  log.fatal({ err }, 'Failed to connect to database');
  process.exit(1);
});
