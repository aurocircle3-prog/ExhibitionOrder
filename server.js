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
const math       = require('mathjs');

const app = express();
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'exhibition-saas-dev-secret';
const MONGO_URI  = process.env.MONGO_URI  || '';
const APP_URL    = process.env.APP_URL    || 'http://localhost:3000';
// Bumped by hand for meaningful releases; BUILD_TIME is set fresh in every
// delivered update — the fast, foolproof way to check "did my last deploy
// actually go live" is to compare this against when you think you pushed.
const APP_VERSION  = '1.20.0';
const BUILD_TIME   = '2026-07-16T06:50:00Z';

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
let S3ListObjectsCommand = null, S3DeleteObjectsCommand = null; // used only when a company is deleted, to clean up its files

function initR2() {
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET && R2_PUBLIC_URL) {
    const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    multerS3 = require('multer-s3');
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
    });
    S3PutObjectCommand = PutObjectCommand;
    S3ListObjectsCommand = ListObjectsV2Command;
    S3DeleteObjectsCommand = DeleteObjectsCommand;
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
  // How rows are combined on the buyer-facing order link — 'none' (default,
  // one row per scanned item) or 'itemName' (items sharing the exact same
  // Item Name merge into one row: numeric fields summed, text fields
  // comma-joined, images combined). Platform-admin-only, not exposed to the
  // company admin — this is AuroCircle choosing a display method for the
  // client, not something the client configures themselves.
  orderRowGrouping: { type: String, enum: ['none', 'itemName'], default: 'none' },
  // Atomically incremented to generate order numbers (EX1001, EX1002...).
  // Replaces the old "count existing orders, then create" approach, which
  // had a race window: two staff submitting at the same instant could both
  // read the same count and get the same order number.
  orderSeq: { type: Number, default: 1000 },
  // Platform-admin-only kill switch — an inactive company is fully locked
  // out (login, API, everything) until reactivated. Not the same as
  // deleting: data stays intact, this is a pause, not a wipe.
  active: { type: Boolean, default: true },
  // Fully custom layout for the public/buyer-facing order link — an ordered
  // list of {id, type, label, width, fieldKey?, formula?}. type is one of
  // 'images' | 'field' | 'formula' | 'serial'. Empty array = fall back to
  // the legacy fixed layout (images + orderFields + qty) for tenants who
  // haven't configured this yet, so existing orders keep rendering the same.
  // Order-level fields — entered ONCE per order (e.g. "Delivery Date",
  // "PO Number"), unlike item fields which are per line item. Each is
  // {key, label, type: 'text'|'number', decimals}.
  orderCustomFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Staff seat limit — set only by the platform admin (AuroCircle), not the
  // company's own admin. null/0 means unlimited (existing companies before
  // this feature keep working exactly as before with no cap).
  maxStaff: { type: Number, default: null },
  // Which of the company's own Settings sections its admin is allowed to
  // configure themselves — platform-admin controlled, default-DENY. AuroCircle
  // does all setup based on what the client asks for; a company admin sees
  // (and can edit) a section only once explicitly granted. This is the
  // opposite of a typical "opt-out" permissions model on purpose — settings
  // access here is opt-in per company, per section.
  settingsPermissions: {
    type: {
      companyName: { type: Boolean, default: false },
      orderForm: { type: Boolean, default: false },
      orderDetailsFields: { type: Boolean, default: false },
      orderViewLayout: { type: Boolean, default: false },
      itemMasterFields: { type: Boolean, default: false },
      orderFooter: { type: Boolean, default: false },
    },
    default: () => ({ companyName: false, orderForm: false, orderDetailsFields: false, orderViewLayout: false, itemMasterFields: false, orderFooter: false }),
  },
  orderViewColumns: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Order-level info shown above/below the item table on the buyer-facing
  // link — e.g. a PO Number above, a Total Weight below. Each entry is
  // either an Order Details field or a total already being computed for a
  // "showTotal" Order Form field; deliberately structured data, not free
  // text, same reasoning as orderViewColumns above.
  orderViewHeaderFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
  orderViewFooterFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Company details shown as a footer on the buyer-facing order link — each
  // field has its own show/hide toggle so e.g. a GST number can be entered
  // without necessarily being made public. logoUrl is a separate top-level
  // field (already used elsewhere) rather than duplicated in here.
  footer: {
    type: {
      address: String, gstNumber: String, whatsappNumber: String,
      instagram: String, facebook: String, twitter: String, youtube: String, website: String,
      show: {
        type: {
          logo: { type: Boolean, default: false }, address: { type: Boolean, default: false },
          gstNumber: { type: Boolean, default: false }, whatsappNumber: { type: Boolean, default: false },
          instagram: { type: Boolean, default: false }, facebook: { type: Boolean, default: false },
          twitter: { type: Boolean, default: false }, youtube: { type: Boolean, default: false }, website: { type: Boolean, default: false },
        },
        default: () => ({}),
      },
    },
    default: () => ({ show: {} }),
  },
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
  fixed: { type: Boolean, default: false }, // built-in field (Unique Barcode / Image Code / Item Name) — cannot be deleted
  required: { type: Boolean, default: false }, // item can't be saved with this field blank (duplicates still allowed unless it's also the scanner key)
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
  firmName: String, contactPerson: String, phone: String, email: String, city: String,
  cardImageUrl: String,
  source: { type: String, default: 'manual' }, // manual | scanned
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const orderSchema = new mongoose.Schema({
  id: String, orderNo: String, tenantId: String, exhibitionId: String,
  partyId: String, partyName: String, partyPhone: String, partyContactPerson: String, partyEmail: String,
  staffId: String, staffName: String,
  items: Array,                       // [{itemId, label, scannerCode, images, qty, extra}]
  remark: String,
  // Snapshot of the tenant's Order Form config at the time this order was
  // placed, plus the computed per-field totals — kept on the order so it
  // still renders correctly even if the admin changes the config later.
  orderFieldsSnapshot: { type: [{ key: String, label: String, unit: String, decimals: Number, showTotal: Boolean }], default: [] },
  fieldTotals: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Snapshot of the tenant's Order View column layout at the time this order
  // was placed — same reasoning as orderFieldsSnapshot above. Empty array
  // means the tenant hadn't configured custom columns yet at that time, so
  // the view page falls back to the legacy fixed layout for this order.
  columnsSnapshot: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Order-level field values (e.g. Delivery Date, PO Number) — one value
  // per order, not per line item. Unlike orderFieldsSnapshot/fieldTotals,
  // this isn't "frozen" at creation; it's just data, edited like remark.
  customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
  showImages: { type: Boolean, default: true },
  status: { type: String, default: 'pending' }, // pending | confirmed | cancelled
  deleted: { type: Boolean, default: false }, // soft delete — kept for audit/history, hidden from normal views
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

// One-time link a newly-created company admin uses to set their own
// password — the platform admin never sets or sees a company's password
// directly. Deliberately its own tiny collection rather than a field on
// User, since it has its own lifecycle (expires, single-use) unrelated to
// the account itself.
const passwordSetupTokenSchema = new mongoose.Schema({
  id: String, token: { type: String, unique: true, sparse: true },
  userId: String, tenantId: String,
  used: { type: Boolean, default: false },
  expiresAt: String, createdAt: { type: String, default: () => new Date().toISOString() },
});

// Images are owned by Image Code, not by any one item — this is the single
// source of truth. Every item sharing an Image Code gets the same photos
// automatically; item.images stays a denormalized copy (kept in sync by
// applyImagesForCode below) purely so every other route that already reads
// item.images directly — order creation, catalog rendering, etc. — doesn't
// need to change at all.
// A platform admin is AuroCircle's own account for overseeing every tenant —
// deliberately a separate model/collection from User. It isn't scoped to any
// tenantId and must never be reachable through the normal per-tenant login
// route. Created only via the CLI seed script (db/seed-platform-admin.js),
// never through a public HTTP endpoint — there's no self-serve signup for
// an account with visibility into every company's data.
const platformAdminSchema = new mongoose.Schema({
  id: String, email: String, password: String, name: String,
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const imageSetSchema = new mongoose.Schema({
  id: String, tenantId: String, imageCode: String,
  images: [String], updatedAt: { type: String, default: () => new Date().toISOString() },
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
const PasswordSetupToken = mongoose.model('PasswordSetupToken', passwordSetupTokenSchema);
const ImageSet    = mongoose.model('ImageSet', imageSetSchema);
const PlatformAdmin = mongoose.model('PlatformAdmin', platformAdminSchema);

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
    db.defaults({ tenants: [], users: [], fielddefs: [], items: [], parties: [], orders: [], exhibitions: [], auditlogs: [], imagesets: [], platformadmins: [], passwordsetuptokens: [] }).write();
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
const PasswordSetupTokenDB = makeCollectionOps(PasswordSetupToken, 'passwordsetuptokens', { createdAt: -1 });
const ImageSetDB   = makeCollectionOps(ImageSet, 'imagesets');
const PlatformAdminDB = makeCollectionOps(PlatformAdmin, 'platformadmins');

// Image Code matching is deliberately case-insensitive everywhere below —
// "4K" and "4k" are treated as the same code. Staff typing codes by hand
// across a long day at a booth will drift in case sooner or later, and a
// silent mismatch there means an item quietly loses its shared photos with
// no visible error, which is a worse failure than just normalizing it away.
async function findImageSetCI(tenantId, imageCode) {
  const needle = String(imageCode).trim().toLowerCase();
  const all = await ImageSetDB.find({ tenantId });
  return all.find(s => String(s.imageCode).trim().toLowerCase() === needle) || null;
}
async function findItemsByImageCode(tenantId, imageCode) {
  const needle = String(imageCode).trim().toLowerCase();
  const items = await ItemDB.find({ tenantId, active: true });
  return items.filter(it => String(it.fields?.imageCode || '').trim().toLowerCase() === needle);
}
async function getImagesForCode(tenantId, imageCode) {
  const set = await findImageSetCI(tenantId, imageCode);
  return set?.images || [];
}
// The single write path for "what photos does this Image Code have" —
// upload, delete, and bulk-import all go through here so every item sharing
// an Image Code always shows the same photos with no per-item re-upload.
async function applyImagesForCode(tenantId, imageCode, images) {
  const existing = await findImageSetCI(tenantId, imageCode);
  if (existing) await ImageSetDB.update({ id: existing.id }, { images, updatedAt: new Date().toISOString() });
  else await ImageSetDB.create({ id: uuid(), tenantId, imageCode, images, updatedAt: new Date().toISOString() });
  const items = await findItemsByImageCode(tenantId, imageCode);
  for (const it of items) await ItemDB.update({ id: it.id }, { images });
  return images;
}

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
  { key: 'itemCode',  label: 'Unique Barcode', type: 'text', isScannerKey: true, fixed: true, required: false },
  { key: 'imageCode', label: 'Image Code',     type: 'text', isScannerKey: false, fixed: true, required: false },
  { key: 'itemName',  label: 'Item Name',      type: 'text', isScannerKey: false, fixed: true, required: true }, // duplicates allowed, unlike Unique Barcode
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
app.get('/api/ping', (req, res) => res.send('expo-orders OK'));
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION, builtAt: BUILD_TIME }));

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
  if (tenant.active === false) return res.status(403).json({ error: 'This company account is currently inactive. Contact AuroCircle for help.' });
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

// Separate from auth() on purpose — a platform admin token has no tenantId
// and must never be accepted by a tenant-scoped route, or vice versa.
function platformAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.platformAdmin) return res.status(401).json({ error: 'Not a platform admin token' });
    req.platformAdmin = payload;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
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

// ── PLATFORM ADMIN (super admin) ─────────────────────────────────────────────
// Entirely separate surface from the per-tenant API above — no resolveTenant,
// no tenant-scoped auth(). Mostly read-only by design: lets AuroCircle see
// every company's account details, users, and settings without being able to
// silently edit a tenant's own data through this surface. The one deliberate
// exception is password reset below — a company admin locked out has no
// other way back in, and this keeps that capability narrow (password only,
// nothing else about the account) rather than opening general user editing.
app.post('/api/platform/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const admin = await PlatformAdminDB.findOne({ email: String(email).trim().toLowerCase() });
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    log.warn({ email, ip: req.ip }, 'Failed platform admin login attempt');
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ platformAdmin: true, id: admin.id, email: admin.email, name: admin.name }, JWT_SECRET, { expiresIn: '12h' });
  log.info({ email: admin.email }, 'Platform admin login');
  res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name } });
});

app.get('/api/platform/tenants', platformAuth, async (req, res) => {
  const tenants = await TenantDB.find({});
  const summaries = await Promise.all(tenants.map(async t => {
    const [userCount, itemCount, orderCount, partyCount] = await Promise.all([
      UserDB.count({ tenantId: t.id }),
      ItemDB.count({ tenantId: t.id, active: true }),
      OrderDB.count({ tenantId: t.id }),
      PartyDB.count({ tenantId: t.id }),
    ]);
    return { id: t.id, name: t.name, slug: t.slug, plan: t.plan, active: t.active !== false, createdAt: t.createdAt, userCount, itemCount, orderCount, partyCount };
  }));
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(summaries);
});

app.get('/api/platform/tenants/:id', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const users = await UserDB.find({ tenantId: tenant.id });
  const safeUsers = users.map(({ password, ...u }) => u);
  const [itemCount, orderCount, partyCount, exhibitionCount, fieldDefs, orders] = await Promise.all([
    ItemDB.count({ tenantId: tenant.id, active: true }),
    OrderDB.count({ tenantId: tenant.id }),
    PartyDB.count({ tenantId: tenant.id }),
    ExhibitionDB.count({ tenantId: tenant.id, active: true }),
    FieldDefDB.find({ tenantId: tenant.id, active: true }),
    OrderDB.find({ tenantId: tenant.id }),
  ]);
  res.json({
    tenant, users: safeUsers, fieldDefs,
    counts: { itemCount, orderCount, partyCount, exhibitionCount },
    recentOrders: orders.slice(0, 10),
  });
});

// Lets the platform admin reset any user's password in any tenant — for
// when a company admin is locked out and has no other way back in. Logged
// to that tenant's own audit trail (actor recorded as the platform admin,
// not a tenant user) so this is never a silent, invisible action.
app.put('/api/platform/tenants/:tenantId/users/:userId/reset-password', platformAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const tenant = await TenantDB.findOne({ id: req.params.tenantId });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const user = await UserDB.findOne({ id: req.params.userId, tenantId: tenant.id });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await UserDB.update({ id: user.id }, { password: bcrypt.hashSync(newPassword, 10) });
  const entry = {
    id: uuid(), tenantId: tenant.id,
    actorId: req.platformAdmin.id, actorName: `${req.platformAdmin.name} (platform admin)`, actorRole: 'platform_admin',
    action: 'user.password_reset_by_platform', entityType: 'user', entityId: user.id,
    changes: { targetUser: user.email || user.loginId }, ip: req.ip, createdAt: new Date().toISOString(),
  };
  AuditLogDB.create(entry).catch(err => log.error({ err }, 'Failed to write audit log'));
  log.info({ tenant: tenant.slug, targetUser: user.email, platformAdmin: req.platformAdmin.email }, 'Platform admin reset a user password');
  res.json({ ok: true });
});

// Companies are created here, not through a public form. The admin account
// is created with no usable password — only a one-time setup link, valid 7
// days, that the new admin uses to set their own password. AuroCircle never
// sets or sees it. (No email service is wired up yet — the link is returned
// directly to the platform admin to share manually; hook up real sending
// later by replacing that one response field with an actual email call.)
app.post('/api/platform/tenants', platformAuth, async (req, res) => {
  const { companyName, slug: rawSlug, adminName, email, phone, maxStaff } = req.body;
  if (!companyName || !rawSlug || !adminName || !email)
    return res.status(400).json({ error: 'Company name, link, admin name, and email are all required' });
  const slug = normalizeSlug(rawSlug);
  const slugErr = validateSlug(slug);
  if (slugErr) return res.status(400).json({ error: slugErr });
  if (await TenantDB.findOne({ slug })) return res.status(400).json({ error: 'That company link name is already taken' });

  const tenant = {
    id: uuid(), name: companyName, slug, plan: 'free', orderSeq: 1000, createdAt: new Date().toISOString(),
    maxStaff: maxStaff !== undefined && maxStaff !== '' ? Number(maxStaff) : null,
    settingsPermissions: { companyName: false, orderForm: false, orderDetailsFields: false, orderViewLayout: false, itemMasterFields: false, orderFooter: false },
  };
  await TenantDB.create(tenant);

  for (let i = 0; i < FIXED_FIELDS.length; i++) {
    await FieldDefDB.create({ id: uuid(), tenantId: tenant.id, order: i, active: true, options: [], createdAt: new Date().toISOString(), ...FIXED_FIELDS[i] });
  }

  const admin = {
    id: uuid(), tenantId: tenant.id, role: 'admin', loginId: String(email).toLowerCase(),
    password: bcrypt.hashSync(uuid(), 10), // random, unusable — real password only ever set via the token link below
    name: adminName, phone: phone || '', email, active: true, createdAt: new Date().toISOString(),
  };
  await UserDB.create(admin);

  const setupToken = uuid();
  await PasswordSetupTokenDB.create({
    id: uuid(), token: setupToken, userId: admin.id, tenantId: tenant.id, used: false,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), createdAt: new Date().toISOString(),
  });
  const baseUrl = (process.env.APP_URL && process.env.APP_URL !== 'http://localhost:3000') ? process.env.APP_URL : `${req.protocol}://${req.get('host')}`;

  log.info({ tenant: tenant.slug, admin: admin.email, platformAdmin: req.platformAdmin.email }, 'Platform admin created a company');
  res.json({ tenant, admin: { id: admin.id, name: admin.name, email: admin.email }, setupLink: `${baseUrl}/set-password.html?token=${setupToken}` });
});

app.put('/api/platform/tenants/:id/max-staff', platformAuth, async (req, res) => {
  const maxStaff = req.body.maxStaff === '' || req.body.maxStaff === null ? null : Number(req.body.maxStaff);
  if (maxStaff !== null && (!Number.isFinite(maxStaff) || maxStaff < 0)) return res.status(400).json({ error: 'Invalid staff limit' });
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  await TenantDB.update({ id: tenant.id }, { maxStaff });
  res.json({ ok: true, maxStaff });
});
app.put('/api/platform/tenants/:id/row-grouping', platformAuth, async (req, res) => {
  const value = req.body.orderRowGrouping;
  if (!['none', 'itemName'].includes(value)) return res.status(400).json({ error: 'Invalid grouping method' });
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  await TenantDB.update({ id: tenant.id }, { orderRowGrouping: value });
  res.json({ ok: true, orderRowGrouping: value });
});

app.put('/api/platform/tenants/:id/permissions', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const allowedKeys = ['companyName', 'orderForm', 'orderDetailsFields', 'orderViewLayout', 'itemMasterFields', 'orderFooter'];
  const settingsPermissions = { ...tenant.settingsPermissions };
  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) settingsPermissions[key] = !!req.body[key];
  }
  await TenantDB.update({ id: tenant.id }, { settingsPermissions });
  res.json({ ok: true, settingsPermissions });
});

app.put('/api/platform/tenants/:id/slug', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const slug = normalizeSlug(req.body.slug || '');
  const slugErr = validateSlug(slug);
  if (slugErr) return res.status(400).json({ error: slugErr });
  const existing = await TenantDB.findOne({ slug });
  if (existing && existing.id !== tenant.id) return res.status(400).json({ error: 'That company link name is already taken' });
  await TenantDB.update({ id: tenant.id }, { slug });
  log.info({ from: tenant.slug, to: slug, platformAdmin: req.platformAdmin.email }, 'Platform admin changed a company slug');
  res.json({ ok: true, slug });
});

app.put('/api/platform/tenants/:id/active', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const active = !!req.body.active;
  await TenantDB.update({ id: tenant.id }, { active });
  log.info({ tenant: tenant.slug, active, platformAdmin: req.platformAdmin.email }, 'Platform admin changed company active status');
  res.json({ ok: true, active });
});

// Irreversible — wipes every record belonging to this tenant across every
// collection, not just the tenant document itself. Gated behind the calling
// platform admin re-entering their OWN password (not the company's), on top
// of already having a valid platform session — a second factor specifically
// because a stolen/left-open platform session shouldn't be enough on its
// own to destroy a company's entire data.
// Cleans up every uploaded file for a tenant — item photos, visiting cards,
// logos — under whichever storage backend is active. Best-effort: logs and
// continues on failure rather than blocking the actual data deletion above,
// since an orphaned file is a much smaller problem than a half-deleted company.
async function deleteTenantFiles(tenantId) {
  try {
    if (useR2 && s3Client) {
      const prefix = `exo/${tenantId}/`;
      let continuationToken;
      do {
        const list = await s3Client.send(new S3ListObjectsCommand({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }));
        if (list.Contents?.length) {
          await s3Client.send(new S3DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) } }));
        }
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);
    } else {
      for (const dir of ['images', 'cards', 'logos']) {
        fs.rmSync(path.join(__dirname, 'uploads', dir, tenantId), { recursive: true, force: true });
      }
    }
  } catch (err) {
    log.error({ err, tenantId }, 'Failed to clean up tenant files during company deletion (data records were still removed)');
  }
}

app.delete('/api/platform/tenants/:id', platformAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Your platform admin password is required to confirm deletion' });
  const me = await PlatformAdminDB.findOne({ id: req.platformAdmin.id });
  if (!me || !bcrypt.compareSync(password, me.password)) return res.status(401).json({ error: 'Incorrect password' });

  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });

  const tenantId = tenant.id;
  await Promise.all([
    UserDB.remove({ tenantId }), FieldDefDB.remove({ tenantId }), ItemDB.remove({ tenantId }),
    PartyDB.remove({ tenantId }), OrderDB.remove({ tenantId }), ExhibitionDB.remove({ tenantId }),
    AuditLogDB.remove({ tenantId }), ImageSetDB.remove({ tenantId }), PasswordSetupTokenDB.remove({ tenantId }),
  ]);
  await deleteTenantFiles(tenantId);
  await TenantDB.remove({ id: tenantId });

  log.warn({ tenant: tenant.slug, tenantId, platformAdmin: req.platformAdmin.email }, 'Platform admin permanently deleted a company and all its data');
  res.json({ ok: true });
});

// Platform admin managing a tenant's Item Master fields and Order Form
// directly — the primary path now, since these are locked from the company
// admin by default (see requireSettingPermission above). No permission gate
// here: the platform admin can always manage any tenant's configuration,
// regardless of what's been opened up for that tenant's own admin. Built on
// the exact same helpers as the tenant-scoped routes, so validation can
// never drift between the two surfaces.
app.post('/api/platform/tenants/:id/fields', platformAuth, async (req, res) => {
  try { res.json(await createFieldForTenant(req.params.id, req.body)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.put('/api/platform/tenants/:id/fields/:fieldId', platformAuth, async (req, res) => {
  try { await updateFieldForTenant(req.params.id, req.params.fieldId, req.body); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.put('/api/platform/tenants/:id/fields/:fieldId/move', platformAuth, async (req, res) => {
  try { await moveFieldForTenant(req.params.id, req.params.fieldId, req.body.direction); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/platform/tenants/:id/fields/:fieldId', platformAuth, async (req, res) => {
  try { await deleteFieldForTenant(req.params.id, req.params.fieldId); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.put('/api/platform/tenants/:id/order-fields', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const result = await saveOrderFieldsForTenant(tenant.id, req.body.orderFields, req.body.showImages);
  res.json({ ok: true, ...result });
});
app.get('/api/platform/tenants/:id/reports', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  res.json(await getReportsForTenant(tenant.id));
});
app.put('/api/platform/tenants/:id/order-custom-fields', platformAuth, async (req, res) => {
  try { res.json({ ok: true, fields: await saveOrderCustomFieldsForTenant(req.params.id, req.body.fields) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.put('/api/platform/tenants/:id/order-view-columns', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  try { res.json({ ok: true, columns: await saveOrderViewColumnsForTenant(tenant, req.body.columns, req.body.headerFields, req.body.footerFields) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.put('/api/platform/tenants/:id/footer', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  res.json({ ok: true, footer: await saveFooterForTenant(tenant.id, req.body) });
});
app.post('/api/platform/tenants/:id/logo', platformAuth, (req, res) => {
  const uploader = makeUploader(`exo/${req.params.id}/logo`, path.join('logos', req.params.id));
  uploader.single('logo')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Logo too large (max 10MB)' : err.message });
    const logoUrl = fileUrl(req.file, path.join('logos', req.params.id));
    await TenantDB.update({ id: req.params.id }, { logoUrl });
    res.json({ ok: true, logoUrl });
  });
});
// Lets the platform admin preview exactly what a company's current Item
// Master field structure produces as a downloadable template — useful right
// after setting up fields, to confirm it looks right before handing
// anything to the client.
app.get('/api/platform/tenants/:id/items/template', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const fieldDefs = await FieldDefDB.find({ tenantId: tenant.id, active: true });
  const headers = fieldDefs.map(fieldHeaderLabel);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws['!cols'] = headers.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Item Master');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${tenant.slug}_Item_Master_Template.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── PASSWORD SETUP (public, token-based — for new company admins) ───────────
app.get('/api/auth/setup-token/:token', async (req, res) => {
  const entry = await PasswordSetupTokenDB.findOne({ token: req.params.token });
  if (!entry || entry.used || new Date(entry.expiresAt) < new Date()) return res.status(400).json({ error: 'This setup link is invalid or has expired.' });
  const user = await UserDB.findOne({ id: entry.userId });
  const tenant = await TenantDB.findOne({ id: entry.tenantId });
  if (!user || !tenant) return res.status(400).json({ error: 'This setup link is invalid or has expired.' });
  res.json({ name: user.name, companyName: tenant.name, companySlug: tenant.slug });
});
app.post('/api/auth/set-password', async (req, res) => {
  const { token, password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const entry = await PasswordSetupTokenDB.findOne({ token });
  if (!entry || entry.used || new Date(entry.expiresAt) < new Date()) return res.status(400).json({ error: 'This setup link is invalid or has expired.' });
  await UserDB.update({ id: entry.userId }, { password: bcrypt.hashSync(password, 10) });
  await PasswordSetupTokenDB.update({ id: entry.id }, { used: true });
  log.info({ userId: entry.userId, tenantId: entry.tenantId }, 'Password set via setup link');
  res.json({ ok: true });
});

// Company self-registration is intentionally disabled — see
// POST /api/platform/tenants below. Kept as a named route (rather than
// removed outright) so the old public form gives a clear message instead
// of a generic 404.
app.post('/api/companies/register', async (req, res) => {
  res.status(403).json({ error: 'New companies are set up by AuroCircle directly — get in touch to get started.' });
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
// Buyer self-registration is disabled — not a feature currently offered.
// Buyers view their orders via the shared order link instead; no account
// needed for that. Kept as a named route rather than removed outright so
// the old form gives a clear message instead of a generic 404.
app.post('/api/auth/register-client', resolveTenant, async (req, res) => {
  res.status(403).json({ error: "Buyer accounts aren't available right now — use the order link your exhibitor sent you instead." });
});

// Staff accounts are never self-signed-up — the admin creates them internally
app.post('/api/staff', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (req.tenant.maxStaff != null) {
    const activeCount = await UserDB.count({ tenantId: req.tenant.id, role: 'staff', active: true });
    if (activeCount >= req.tenant.maxStaff) {
      return res.status(400).json({ error: `Staff limit reached (${req.tenant.maxStaff}). Contact AuroCircle to increase it.` });
    }
  }
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

// Buyer/client logins — buyer self-registration is disabled (see
// register-client above), so this is now the only way a client account
// gets created: the company admin sets one up directly, e.g. for a repeat
// buyer who wants to see their order history without needing a fresh link
// each time. Deliberately mirrors the staff account routes above.
app.post('/api/clients', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const loginId = (email || phone || name).toLowerCase();
  if (await UserDB.findOne({ tenantId: req.tenant.id, loginId }))
    return res.status(400).json({ error: 'That login ID is already in use' });
  const client = {
    id: uuid(), tenantId: req.tenant.id, role: 'client', loginId,
    password: bcrypt.hashSync(password, 10), name, phone: phone || '', email: email || '',
    active: true, createdAt: new Date().toISOString(),
  };
  await UserDB.create(client);
  logAudit(req, 'client.create', 'user', client.id, { name: client.name, loginId: client.loginId });
  const { password: _pw, ...safeClient } = client;
  res.json(safeClient);
});
app.get('/api/clients', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const clients = await UserDB.find({ tenantId: req.tenant.id, role: 'client' });
  res.json(clients.map(({ password: _pw, ...c }) => c));
});
app.put('/api/clients/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const clientUser = await UserDB.findOne({ id: req.params.id, tenantId: req.tenant.id, role: 'client' });
  if (!clientUser) return res.status(404).json({ error: 'Buyer login not found' });
  const updates = {};
  ['name', 'phone', 'email', 'active'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (req.body.newPassword) {
    if (req.body.newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 characters' });
    updates.password = bcrypt.hashSync(req.body.newPassword, 10);
  }
  await UserDB.update({ id: req.params.id }, updates);
  logAudit(req, 'client.update', 'user', req.params.id, { fields: Object.keys(updates) });
  res.json({ ok: true });
});
app.delete('/api/clients/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  await UserDB.remove({ id: req.params.id, tenantId: req.tenant.id, role: 'client' });
  logAudit(req, 'client.delete', 'user', req.params.id);
  res.json({ ok: true });
});

app.get('/api/me', resolveTenant, auth, async (req, res) => {
  const user = await UserDB.findOne({ id: req.user.id });
  if (!user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  const { password: _pw, ...safeUser } = user;
  res.json({ ...safeUser, tenant: req.tenant });
});

// Blocks a company admin from editing a settings section unless the
// platform admin has explicitly granted it — default-deny. Not just a UI
// nicety: this is the actual enforcement point; the settings UI hiding
// sections entirely is a courtesy on top of this.
function requireSettingPermission(key) {
  return (req, res, next) => {
    if (req.tenant.settingsPermissions?.[key] !== true) {
      return res.status(403).json({ error: 'This setting is managed by AuroCircle for your account — contact us to change it.' });
    }
    next();
  };
}

app.put('/api/companies/settings', resolveTenant, auth, requireRole('admin'), requireSettingPermission('companyName'), async (req, res) => {
  const updates = {};
  ['name'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  await TenantDB.update({ id: req.tenant.id }, updates);
  logAudit(req, 'company.settings_update', 'tenant', req.tenant.id, updates);
  res.json({ ok: true });
});

// Which item fields show up per line on the order link, and which get summed
// into a total — validated against the tenant's real fields so a stale/typo'd
// key can't sneak in.
app.put('/api/companies/order-fields', resolveTenant, auth, requireRole('admin'), requireSettingPermission('orderForm'), async (req, res) => {
  const result = await saveOrderFieldsForTenant(req.tenant.id, req.body.orderFields, req.body.showImages);
  res.json({ ok: true, ...result });
});

// Order-level custom fields (Delivery Date, PO Number, etc.) — asked once
// per order while taking it, not per item. Kept deliberately simple next to
// Item Master fields: just a key/label/type, no scanner keys or options.
async function saveOrderCustomFieldsForTenant(tenantId, list) {
  const seen = new Set();
  const fields = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const label = String(raw?.label || '').trim().slice(0, 60);
    if (!label) throw Object.assign(new Error('Every order field needs a name'), { status: 400 });
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `field_${fields.length}`;
    if (seen.has(key)) throw Object.assign(new Error(`Two fields produced the same key ("${label}") — use distinct names`), { status: 400 });
    seen.add(key);
    const type = raw.type === 'number' ? 'number' : 'text';
    const decimals = type === 'number' ? Math.min(Math.max(Number(raw.decimals) || 0, 0), 6) : undefined;
    fields.push({ key, label, type, ...(decimals !== undefined ? { decimals } : {}) });
  }
  await TenantDB.update({ id: tenantId }, { orderCustomFields: fields });
  return fields;
}

app.put('/api/companies/order-custom-fields', resolveTenant, auth, requireRole('admin'), requireSettingPermission('orderDetailsFields'), async (req, res) => {
  try { res.json({ ok: true, fields: await saveOrderCustomFieldsForTenant(req.tenant.id, req.body.fields) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Shared by order create + edit — normalizes order-level custom field
// values against the tenant's defined fields, same defensive pattern as
// normalizeFieldValues: unknown keys are dropped, numbers are coerced and
// rounded to the field's configured decimals.
function normalizeCustomFields(defs, raw) {
  const out = {};
  const byKey = {}; defs.forEach(f => { byKey[f.key] = f; });
  for (const [key, val] of Object.entries(raw || {})) {
    const def = byKey[key];
    if (!def) continue;
    if (def.type === 'number' && val !== '' && val !== null && val !== undefined) {
      const n = Number(val);
      out[key] = isNaN(n) ? '' : Number(n.toFixed(def.decimals ?? 2));
    } else {
      out[key] = String(val ?? '').slice(0, 500);
    }
  }
  return out;
}

// The buyer-facing order link's layout — an ordered list of columns, each
// independently typed (photos / a specific field / a computed formula /
// row number) with its own header text and width. Formulas are validated
// here with mathjs's parser (never eval/Function — that would let an admin
// account run arbitrary JS in every visitor's browser and on this server),
// checked for valid syntax and that every variable name it references is
// actually a real Order Form field (or "qty") — a formula referencing a
// typo'd or deleted field would just silently show blank to every buyer
// otherwise.
// Lets a formula use "%" the way people actually write percentages in this
// industry — e.g. "net_weight * (melting + wastage) %" for a fine-weight
// calculation — rather than requiring "/100" instead. mathjs treats a bare
// "%" as the modulo operator, so "(x)%" alone is invalid syntax to it; this
// rewrites "(EXPR)%" and "name%"/"number%" into "(EXPR/100)" before parsing,
// so the formula still reads naturally when someone re-opens it to edit.
function preprocessPercent(expr) {
  let result = expr.replace(/\(([^()]*)\)\s*%/g, '(($1)/100)');
  result = result.replace(/([A-Za-z_][A-Za-z0-9_]*|\d+(\.\d+)?)\s*%(?!\w)/g, '($1/100)');
  return result;
}
function validateFormula(expr, allowedNames) {
  let parsed;
  try { parsed = math.parse(preprocessPercent(expr)); }
  catch (e) { return { ok: false, error: `Invalid formula: ${e.message}` }; }
  const used = new Set();
  parsed.traverse(node => { if (node.isSymbolNode) used.add(node.name); });
  const unknown = [...used].filter(n => !allowedNames.has(n));
  if (unknown.length) return { ok: false, error: `Formula uses unknown field(s): ${unknown.join(', ')}` };
  return { ok: true };
}

async function saveOrderViewColumnsForTenant(tenant, list, headerFields, footerFields) {
  const orderFields = tenant.orderFields || [];
  // Field/Formula columns can reference ANY active Item Master field, not
  // just ones added to the Order Form — Order Form controls what staff can
  // edit per line and what gets totaled, but the display layout is a
  // separate concern and shouldn't be limited to that subset. Every active
  // field's value is already snapshotted onto every order line (see
  // buildOrderLines) specifically so this works.
  const fieldDefs = await FieldDefDB.find({ tenantId: tenant.id, active: true });
  const fieldByKey = {}; fieldDefs.forEach(f => { fieldByKey[f.key] = f; });
  const allowedFieldKeys = new Set(fieldDefs.map(f => f.key));
  // Formulas can only meaningfully use numeric fields — a text field like
  // "Category" can't be multiplied.
  const allowedFormulaNames = new Set([...fieldDefs.filter(f => f.type === 'number').map(f => f.key), 'qty']);
  const orderCustomFields = tenant.orderCustomFields || [];
  const allowedOrderFieldKeys = new Set(orderCustomFields.map(f => f.key));
  const totalableKeys = new Set(orderFields.filter(f => f.showTotal).map(f => f.key));

  const columns = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (!raw || !['images', 'field', 'formula', 'serial', 'remark', 'orderfield', 'itemcode', 'qty'].includes(raw.type)) {
      throw Object.assign(new Error('Each column needs a valid type'), { status: 400 });
    }
    const width = Number(raw.width);
    if (!Number.isFinite(width) || width < 3 || width > 80) {
      throw Object.assign(new Error('Column width must be between 3 and 80 characters'), { status: 400 });
    }
    const col = { id: raw.id || uuid(), type: raw.type, width };

    if (raw.type === 'field') {
      if (!allowedFieldKeys.has(raw.fieldKey)) throw Object.assign(new Error(`"${raw.fieldKey}" isn't an Item Master field — add it there first`), { status: 400 });
      const f = fieldByKey[raw.fieldKey];
      col.fieldKey = raw.fieldKey;
      col.unit = f.unit || ''; // stored directly so the public order view never needs to re-look-up field metadata
      col.decimals = f.type === 'number' ? (f.decimals ?? 2) : undefined;
      col.label = (raw.label || f.label || '').trim().slice(0, 60) || f.label;
    } else if (raw.type === 'orderfield') {
      if (!allowedOrderFieldKeys.has(raw.fieldKey)) throw Object.assign(new Error(`"${raw.fieldKey}" isn't one of the Order Details fields — add it there first`), { status: 400 });
      const f = orderCustomFields.find(x => x.key === raw.fieldKey);
      col.fieldKey = raw.fieldKey;
      col.label = (raw.label || f.label || '').trim().slice(0, 60) || f.label;
    } else if (raw.type === 'formula') {
      const formula = String(raw.formula || '').trim();
      if (!formula) throw Object.assign(new Error('Formula column needs a formula'), { status: 400 });
      const check = validateFormula(formula, allowedFormulaNames);
      if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
      col.formula = formula;
      col.label = (raw.label || 'Amount').trim().slice(0, 60) || 'Amount';
    } else if (raw.type === 'images') {
      col.label = (raw.label || 'Photo').trim().slice(0, 60) || 'Photo';
    } else if (raw.type === 'remark') {
      col.label = (raw.label || 'Remark').trim().slice(0, 60) || 'Remark';
    } else if (raw.type === 'itemcode') {
      col.label = (raw.label || 'Item Code').trim().slice(0, 60) || 'Item Code';
    } else if (raw.type === 'qty') {
      col.label = (raw.label || 'Qty').trim().slice(0, 60) || 'Qty';
    } else { // serial
      col.label = (raw.label || 'Sr. No.').trim().slice(0, 60) || 'Sr. No.';
    }
    columns.push(col);
  }

  // Header/footer "fields" — order-level info shown above/below the item
  // table, e.g. a PO Number above, a Total Weight below. Each is either an
  // Order Details field or one of the totals already being computed for a
  // "showTotal" Order Form field — deliberately not free text, so this
  // stays structured data rather than a loose text box.
  function validateFieldList(list) {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      if (!raw || !['orderfield', 'total'].includes(raw.type)) throw Object.assign(new Error('Each field needs a valid type'), { status: 400 });
      if (raw.type === 'orderfield') {
        if (!allowedOrderFieldKeys.has(raw.fieldKey)) throw Object.assign(new Error(`"${raw.fieldKey}" isn't one of the Order Details fields — add it there first`), { status: 400 });
        const f = orderCustomFields.find(x => x.key === raw.fieldKey);
        out.push({ type: 'orderfield', fieldKey: raw.fieldKey, label: (raw.label || f.label || '').trim().slice(0, 60) || f.label });
      } else { // total
        if (!totalableKeys.has(raw.fieldKey)) throw Object.assign(new Error(`"${raw.fieldKey}" isn't a field with "Show total" turned on — enable that on the Order Form first`), { status: 400 });
        const f = orderFields.find(x => x.key === raw.fieldKey);
        out.push({ type: 'total', fieldKey: raw.fieldKey, label: (raw.label || `Total ${f.label}`).trim().slice(0, 60) || `Total ${f.label}` });
      }
    }
    return out;
  }
  const updates = { orderViewColumns: columns };
  if (headerFields !== undefined) updates.orderViewHeaderFields = validateFieldList(headerFields);
  if (footerFields !== undefined) updates.orderViewFooterFields = validateFieldList(footerFields);
  await TenantDB.update({ id: tenant.id }, updates);
  return columns;
}

app.put('/api/companies/order-view-columns', resolveTenant, auth, requireRole('admin'), requireSettingPermission('orderViewLayout'), async (req, res) => {
  try { res.json({ ok: true, columns: await saveOrderViewColumnsForTenant(req.tenant, req.body.columns, req.body.headerFields, req.body.footerFields) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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

// Company details shown as a footer on the buyer-facing order link. Each
// field is stored regardless of its show/hide toggle — a company can type
// in its GST number to have on file without necessarily publishing it —
// the public order route below is what actually filters by `show`.
const FOOTER_TEXT_FIELDS = ['address', 'gstNumber', 'whatsappNumber', 'instagram', 'facebook', 'twitter', 'youtube', 'website'];
const FOOTER_SHOW_KEYS = ['logo', ...FOOTER_TEXT_FIELDS];
async function saveFooterForTenant(tenantId, body) {
  const footer = { show: {} };
  for (const key of FOOTER_TEXT_FIELDS) footer[key] = String(body[key] || '').trim().slice(0, 300);
  for (const key of FOOTER_SHOW_KEYS) footer.show[key] = !!body.show?.[key];
  await TenantDB.update({ id: tenantId }, { footer });
  return footer;
}
app.put('/api/companies/footer', resolveTenant, auth, requireRole('admin'), requireSettingPermission('orderFooter'), async (req, res) => {
  res.json({ ok: true, footer: await saveFooterForTenant(req.tenant.id, req.body) });
});

// ── ITEM MASTER FIELD DEFINITIONS — the "10-12 fields, add/delete, customer-wise" builder ──
// Shared by the tenant-scoped field routes (gated by requireSettingPermission)
// and the platform-admin equivalents below (which bypass that gate by
// design — the platform admin can always manage any tenant's fields,
// regardless of what's been opened up for that tenant's own admin). Single-
// sourced so the two surfaces can never drift into different validation rules.
async function createFieldForTenant(tenantId, body) {
  const { label, type, options, decimals, unit } = body;
  if (!label || !label.trim()) throw Object.assign(new Error('Field label is required'), { status: 400 });
  if (RESERVED_FIELD_LABELS.includes(label.trim().toLowerCase()))
    throw Object.assign(new Error(`"${label.trim()}" is a built-in field already on every item`), { status: 400 });
  const key = normalizeSlug(label).replace(/-/g, '_') || uuid().slice(0, 8);
  if (await FieldDefDB.findOne({ tenantId, key, active: true }))
    throw Object.assign(new Error('A field with a similar name already exists'), { status: 400 });
  const existing = await FieldDefDB.find({ tenantId, active: true });
  const field = {
    id: uuid(), tenantId, key, label: label.trim(),
    type: type || 'text', options: Array.isArray(options) ? options : [],
    decimals: type === 'number' ? Math.max(0, Math.min(6, Number(decimals) || 0)) : 2,
    unit: type === 'number' ? String(unit || '').trim() : '',
    order: existing.length, isScannerKey: false, fixed: false, active: true, createdAt: new Date().toISOString(),
  };
  await FieldDefDB.create(field);
  return field;
}
async function updateFieldForTenant(tenantId, fieldId, body) {
  const field = await FieldDefDB.findOne({ id: fieldId, tenantId });
  if (!field) throw Object.assign(new Error('Field not found'), { status: 404 });
  const updates = {};
  if (body.label !== undefined && body.label.trim()) updates.label = body.label.trim();
  if (body.options !== undefined) updates.options = body.options;
  if (body.order !== undefined) updates.order = body.order;
  if (body.type !== undefined && !field.fixed) updates.type = body.type; // fixed fields always stay text
  if (body.decimals !== undefined) updates.decimals = Math.max(0, Math.min(6, Number(body.decimals) || 0));
  if (body.unit !== undefined) updates.unit = String(body.unit).trim();
  await FieldDefDB.update({ id: fieldId }, updates);
}
async function moveFieldForTenant(tenantId, fieldId, direction) {
  const list = await FieldDefDB.find({ tenantId, active: true }); // sorted by order
  const idx = list.findIndex(f => f.id === fieldId);
  if (idx === -1) throw Object.assign(new Error('Field not found'), { status: 404 });
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return; // already at the edge
  const aId = list[idx].id, aOrder = list[idx].order;
  const bId = list[swapIdx].id, bOrder = list[swapIdx].order;
  await FieldDefDB.update({ id: aId }, { order: bOrder });
  await FieldDefDB.update({ id: bId }, { order: aOrder });
}
async function deleteFieldForTenant(tenantId, fieldId) {
  const field = await FieldDefDB.findOne({ id: fieldId, tenantId });
  if (!field) throw Object.assign(new Error('Field not found'), { status: 404 });
  if (field.fixed) throw Object.assign(new Error(`"${field.label}" is a built-in field and can't be deleted`), { status: 400 });
  await FieldDefDB.remove({ id: fieldId });
}
async function saveOrderFieldsForTenant(tenantId, list, showImages) {
  const fieldDefs = await FieldDefDB.find({ tenantId, active: true });
  const byKey = {}; fieldDefs.forEach(f => { byKey[f.key] = f; });
  const orderFields = (Array.isArray(list) ? list : [])
    .filter(f => f && byKey[f.key])
    .map(f => ({ key: f.key, label: byKey[f.key].label, unit: byKey[f.key].unit || '', type: byKey[f.key].type, decimals: byKey[f.key].type === 'number' ? (byKey[f.key].decimals ?? 2) : undefined, showTotal: !!f.showTotal }));
  const orderShowImages = showImages !== undefined ? !!showImages : true;
  await TenantDB.update({ id: tenantId }, { orderFields, orderShowImages });
  return { orderFields, orderShowImages };
}

app.get('/api/fields', resolveTenant, auth, async (req, res) => {
  const fields = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
  res.json(fields);
});

app.post('/api/fields', resolveTenant, auth, requireRole('admin'), requireSettingPermission('itemMasterFields'), async (req, res) => {
  try { res.json(await createFieldForTenant(req.tenant.id, req.body)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/fields/:id', resolveTenant, auth, requireRole('admin'), requireSettingPermission('itemMasterFields'), async (req, res) => {
  try { await updateFieldForTenant(req.tenant.id, req.params.id, req.body); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Swaps this field's order with its neighbor — used by the ↑/↓ buttons in the field builder
app.put('/api/fields/:id/move', resolveTenant, auth, requireRole('admin'), requireSettingPermission('itemMasterFields'), async (req, res) => {
  try { await moveFieldForTenant(req.tenant.id, req.params.id, req.body.direction); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Soft-delete — keeps historical items readable even after a field is removed from the builder.
// The two built-in fields (Item Code, Image Code) can never be deleted.
app.delete('/api/fields/:id', resolveTenant, auth, requireRole('admin'), requireSettingPermission('itemMasterFields'), async (req, res) => {
  try { await deleteFieldForTenant(req.tenant.id, req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
    if ((key === 'itemCode' || key === 'imageCode') && val !== '' && val !== null && val !== undefined) {
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

// Shared by item create + update — checks every field marked `required` on
// the tenant's field defs actually has a value. Unlike the scanner-key
// (Unique Barcode) uniqueness check above, this has nothing to do with
// duplicates — Item Name is required but duplicate names are fine.
function validateRequiredFields(fieldDefs, fields) {
  for (const def of fieldDefs) {
    if (def.required && !String(fields?.[def.key] ?? '').trim()) {
      return `${def.label} is required`;
    }
  }
  return null;
}

app.post('/api/items', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const { fields: rawFields, exhibitionId } = req.body;
  if (!rawFields || typeof rawFields !== 'object') return res.status(400).json({ error: 'fields object is required' });
  const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
  const fields = normalizeFieldValues(fieldDefs, rawFields);
  const requiredErr = validateRequiredFields(fieldDefs, fields);
  if (requiredErr) return res.status(400).json({ error: requiredErr });
  const scannerCode = scannerCodeOf(fields);
  if (scannerCode && await ItemDB.findOne({ tenantId: req.tenant.id, scannerCode, active: true }))
    return res.status(400).json({ error: `An item with scanner code "${scannerCode}" already exists` });
  const imageCode = String(fields.imageCode || '').trim();
  const item = {
    id: uuid(), tenantId: req.tenant.id, exhibitionId: exhibitionId || '',
    scannerCode, fields, images: imageCode ? await getImagesForCode(req.tenant.id, imageCode) : [],
    active: true, createdAt: new Date().toISOString(),
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
    const requiredErr = validateRequiredFields(fieldDefs, updates.fields);
    if (requiredErr) return res.status(400).json({ error: requiredErr });
    updates.scannerCode = scannerCodeOf(updates.fields);
    const oldCode = String(item.fields?.imageCode || '').trim().toLowerCase();
    const newCode = String(updates.fields.imageCode || '').trim().toLowerCase();
    // Image Code changed — this item now belongs to a different (or no)
    // shared photo set, so swap its images to match rather than keep stale ones.
    if (newCode !== oldCode) updates.images = newCode ? await getImagesForCode(req.tenant.id, updates.fields.imageCode) : [];
  }
  await ItemDB.update({ id: req.params.id }, updates);
  res.json({ ok: true });
});

app.delete('/api/items/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  await ItemDB.remove({ id: req.params.id, tenantId: req.tenant.id });
  logAudit(req, 'item.delete', 'item', req.params.id);
  res.json({ ok: true });
});
app.post('/api/items/bulk-delete', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
  if (!ids.length) return res.status(400).json({ error: 'No items selected' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many at once — delete in smaller batches (max 500)' });
  for (const id of ids) {
    await ItemDB.remove({ id, tenantId: req.tenant.id });
  }
  logAudit(req, 'item.bulk_delete', 'item', ids.length, { count: ids.length, ids });
  res.json({ ok: true, deleted: ids.length });
});
// Wipes the entire item catalog for this company in one action — a step
// further than bulk-delete-by-selection, for a full reset/restart.
app.post('/api/items/delete-all', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const existing = await ItemDB.find({ tenantId: req.tenant.id });
  await ItemDB.remove({ tenantId: req.tenant.id });
  logAudit(req, 'item.delete_all', 'item', existing.length, { count: existing.length });
  res.json({ ok: true, deleted: existing.length });
});

// Photos are named from the item's Image Code (see makeItemImageUploader) —
// the field must be set first, and each item is capped at 3 photos total.
app.post('/api/items/:id/images', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const item = await ItemDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const imageCode = String(item.fields?.imageCode || '').trim();
  if (!imageCode) return res.status(400).json({ error: 'Set the Image Code field on this item before uploading photos' });
  const existing = await getImagesForCode(req.tenant.id, imageCode);
  if (existing.length >= 3) return res.status(400).json({ error: 'This Image Code already has the maximum of 3 photos — remove one first' });

  const remaining = 3 - existing.length;
  const localDir = path.join('images', req.tenant.id);
  const uploader = makeItemImageUploader(req.tenant.id, imageCode, existing.length);
  uploader.array('images', remaining)(req, res, async err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image too large (max 10MB)' });
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `Only ${remaining} more photo(s) fit (max 3 total) — select fewer files` });
      return res.status(400).json({ error: err.message });
    }
    const newUrls = req.files.map(f => fileUrl(f, localDir));
    const images = await applyImagesForCode(req.tenant.id, imageCode, [...existing, ...newUrls]);
    res.json({ ok: true, images });
  });
});

// Removes one photo (by its position) from the shared Image Code set — this
// affects every item using that code, since they're the same photos.
app.delete('/api/items/:id/images/:index', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const item = await ItemDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const imageCode = String(item.fields?.imageCode || '').trim();
  if (!imageCode) return res.status(404).json({ error: 'This item has no Image Code set' });
  const idx = Number(req.params.index);
  const current = await getImagesForCode(req.tenant.id, imageCode);
  const images = await applyImagesForCode(req.tenant.id, imageCode, current.filter((_, i) => i !== idx));
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
    const codesInUse = new Set(items.map(it => String(it.fields?.imageCode || '').trim().toLowerCase()).filter(Boolean));

    const groups = {};
    req.files.forEach(file => {
      const { code, slot, ext } = parseImageFilename(file.originalname);
      (groups[code] ??= []).push({ file, slot, ext });
    });

    let matched = 0, unmatchedCode = 0, full = 0;
    for (const code of Object.keys(groups)) {
      const candidates = groups[code].sort((a, b) => a.slot - b.slot);
      if (!codesInUse.has(code.toLowerCase())) { unmatchedCode += candidates.length; continue; }

      const images = await getImagesForCode(req.tenant.id, code);
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
      // Cascades to every item sharing this Image Code, not just one —
      // this was the actual bug: previously only the last-seen item per
      // code got the photos, silently dropping any others sharing it.
      await applyImagesForCode(req.tenant.id, code, images);
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
        if (validateRequiredFields(fieldDefs, fields)) { skipped++; continue; }
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
    // The card image is already safely saved at this point — everything
    // below is a "nice to have" auto-fill enhancement (server-side OCR),
    // not something the request should fail over. In R2 mode this needs to
    // re-fetch the file from its own public URL, which previously had no
    // error handling at all: any hiccup (R2 propagation delay, a network
    // blip) left the request hanging indefinitely with no response, which
    // is exactly what shows up client-side as a generic "failed to fetch."
    let guess = { firmName: '', contactPerson: '', phone: '', email: '' };
    try {
      const base64 = useR2
        ? Buffer.from(await (await fetch(cardImageUrl)).arrayBuffer()).toString('base64')
        : fs.readFileSync(req.file.path).toString('base64');
      guess = await runVisitingCardOcr(base64);
    } catch (ocrErr) {
      log.warn({ err: ocrErr }, 'Card OCR step failed — card image was still saved, just no auto-fill guess from it');
    }
    res.json({ cardImageUrl, guess });
  });
});

app.post('/api/parties', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const { firmName, contactPerson, phone, email, city, cardImageUrl, source } = req.body;
  if (!firmName || !phone) return res.status(400).json({ error: 'Firm name and phone are required' });
  // Phone is the unique key for a buyer — if this number is already on file
  // (from a past exhibition, or scanned again this year), update that
  // existing record with whatever's freshest rather than creating a
  // duplicate entry for the same person.
  const existing = await PartyDB.findOne({ tenantId: req.tenant.id, phone });
  if (existing) {
    const updates = { firmName, contactPerson: contactPerson || '', email: email || '', city: city || '' };
    if (cardImageUrl) updates.cardImageUrl = cardImageUrl;
    await PartyDB.update({ id: existing.id }, updates);
    return res.json({ ...existing, ...updates });
  }
  const party = {
    id: uuid(), tenantId: req.tenant.id, firmName, contactPerson: contactPerson || '',
    phone, email: email || '', city: city || '', cardImageUrl: cardImageUrl || '',
    source: source === 'scanned' ? 'scanned' : 'manual', createdAt: new Date().toISOString(),
  };
  await PartyDB.create(party);
  res.json(party);
});
app.put('/api/parties/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const party = await PartyDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!party) return res.status(404).json({ error: 'Buyer not found' });
  const { firmName, contactPerson, phone, email, city } = req.body;
  if (!firmName || !phone) return res.status(400).json({ error: 'Firm name and phone are required' });
  if (phone !== party.phone) {
    const clash = await PartyDB.findOne({ tenantId: req.tenant.id, phone });
    if (clash) return res.status(400).json({ error: 'Another buyer already uses that phone number' });
  }
  const updates = { firmName, contactPerson: contactPerson || '', phone, email: email || '', city: city || '' };
  await PartyDB.update({ id: req.params.id }, updates);
  res.json({ ok: true });
});
app.delete('/api/parties/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  await PartyDB.remove({ id: req.params.id, tenantId: req.tenant.id });
  logAudit(req, 'party.delete', 'party', req.params.id);
  res.json({ ok: true });
});

app.get('/api/parties', resolveTenant, auth, async (req, res) => {
  let parties = await PartyDB.find({ tenantId: req.tenant.id });
  if (req.query.q) {
    const needle = String(req.query.q).toLowerCase();
    parties = parties.filter(p => p.firmName?.toLowerCase().includes(needle) || p.phone?.includes(needle) || p.city?.toLowerCase().includes(needle) || p.contactPerson?.toLowerCase().includes(needle));
  }
  res.json(parties);
});

app.get('/api/parties/:id', resolveTenant, auth, async (req, res) => {
  const party = await PartyDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!party) return res.status(404).json({ error: 'Party not found' });
  res.json(party);
});

// ── ORDERS ────────────────────────────────────────────────────────────────────
// Shared by order create + order edit — turns { itemId, qty, extra, comment }
// lines into full order line items (label, images, per-field snapshot) and
// computes the showTotal field sums. Re-reads items fresh each time so an
// edit always reflects the item master's current fields, not stale data
// from creation — but a line's own `extra` values (if the staff typed an
// override, e.g. this sale's actual melting % differs from the item
// master default) win over the item master default for that field.
async function buildOrderLines(tenant, items) {
  const orderFields = tenant.orderFields || [];
  const orderKeys = new Set(orderFields.map(f => f.key));
  const fieldDefs = await FieldDefDB.find({ tenantId: tenant.id, active: true });
  const lineItems = [];
  for (const line of items) {
    const item = await ItemDB.findOne({ id: line.itemId, tenantId: tenant.id });
    if (!item) continue;
    const qty = Number(line.qty) || 1;
    // Every active Item Master field gets snapshotted, not just the ones on
    // the Order Form — Order Form only controls which fields staff can
    // override per-line and which get totaled; a column in Order View
    // Layout can reference any Item Master field regardless, and needs the
    // value to actually be here to display it.
    const rawExtra = {};
    fieldDefs.forEach(f => { rawExtra[f.key] = item.fields?.[f.key] ?? ''; });
    if (line.extra && typeof line.extra === 'object') {
      for (const [k, v] of Object.entries(line.extra)) {
        if (orderKeys.has(k)) rawExtra[k] = v; // only known Order Form fields — never trust arbitrary keys from the client
      }
    }
    const extra = normalizeFieldValues(fieldDefs, rawExtra);
    lineItems.push({
      itemId: item.id, label: item.fields?.itemName || item.fields?.productName || item.scannerCode || item.id,
      scannerCode: item.scannerCode, images: item.images || [],
      qty, extra, comment: typeof line.comment === 'string' ? line.comment.trim().slice(0, 500) : '',
    });
  }
  const fieldTotals = {};
  orderFields.filter(f => f.showTotal).forEach(f => {
    const raw = lineItems.reduce((sum, l) => sum + (Number(l.extra?.[f.key]) || 0) * l.qty, 0);
    fieldTotals[f.key] = Number(raw.toFixed(f.decimals ?? 2));
  });
  return { lineItems, fieldTotals, orderFields };
}

// Atomically claims the next order number for a tenant. Uses Mongo's $inc
// (a true atomic increment — safe for two staff submitting in the same
// instant) instead of the old "count orders, then create" approach. If a
// tenant predates this field (orderSeq missing), seeds it once from the
// existing order count so numbering keeps incrementing rather than
// restarting — that one-time seed has a small race window of its own, but
// only on the very first order after upgrade, which is an acceptable trade
// vs. the previous always-racy behavior.
async function nextOrderNo(tenant) {
  if (useMongoose) {
    let t = await Tenant.findOne({ id: tenant.id });
    if (t.orderSeq == null) {
      const count = await Order.countDocuments({ tenantId: tenant.id });
      t = await Tenant.findOneAndUpdate({ id: tenant.id }, { $set: { orderSeq: 1000 + count } }, { new: true });
    }
    const updated = await Tenant.findOneAndUpdate({ id: tenant.id }, { $inc: { orderSeq: 1 } }, { new: true });
    return `EX${updated.orderSeq}`;
  }
  // lowdb — dev-only, single Node process, no real concurrency to race against.
  let t = db.get('tenants').find({ id: tenant.id }).value();
  if (t.orderSeq == null) {
    const count = await OrderDB.count({ tenantId: tenant.id });
    db.get('tenants').find({ id: tenant.id }).assign({ orderSeq: 1000 + count }).write();
  }
  t = db.get('tenants').find({ id: tenant.id }).value();
  const next = t.orderSeq + 1;
  db.get('tenants').find({ id: tenant.id }).assign({ orderSeq: next }).write();
  return `EX${next}`;
}

app.post('/api/orders', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const { partyId, exhibitionId, items, remark, customFields } = req.body;
  if (!partyId || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'partyId and at least one item are required' });
  const party = await PartyDB.findOne({ id: partyId, tenantId: req.tenant.id });
  if (!party) return res.status(404).json({ error: 'Party not found' });

  // No built-in "price" concept — every value on an order (price, weight,
  // whatever) is just a regular Item Master field, shown per the tenant's
  // Order Form config below. Qty is the only quantity that's always tracked.
  const { lineItems, fieldTotals, orderFields } = await buildOrderLines(req.tenant, items);
  if (!lineItems.length) return res.status(400).json({ error: 'No valid items in this order' });
  const orderNo = await nextOrderNo(req.tenant);

  const order = {
    id: uuid(), orderNo, tenantId: req.tenant.id,
    exhibitionId: exhibitionId || '', partyId, partyName: party.firmName, partyPhone: party.phone, partyContactPerson: party.contactPerson || '', partyEmail: party.email || '',
    staffId: req.user.id, staffName: req.user.name,
    items: lineItems, remark: remark || '', status: 'pending',
    orderFieldsSnapshot: orderFields, fieldTotals,
    columnsSnapshot: req.tenant.orderViewColumns || [],
    customFields: normalizeCustomFields(req.tenant.orderCustomFields || [], customFields),
    showImages: req.tenant.orderShowImages !== false,
    shareToken: uuid(), createdAt: new Date().toISOString(),
  };
  await OrderDB.create(order);
  logAudit(req, 'order.create', 'order', order.id, { orderNo: order.orderNo, partyId, itemCount: lineItems.length });
  // APP_URL is meant to be set explicitly in production, but a misconfigured
  // or forgotten env var shouldn't silently break every shared order link —
  // fall back to the actual request's host, which is always correct.
  const baseUrl = (process.env.APP_URL && process.env.APP_URL !== 'http://localhost:3000')
    ? APP_URL
    : `${req.protocol}://${req.get('host')}`;
  res.json({ ...order, shareUrl: `${baseUrl}/order/${order.shareToken}` });
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
  const orders = (await OrderDB.find(q)).filter(o => !o.deleted);
  res.json(orders);
});

app.get('/api/orders/:id', resolveTenant, auth, async (req, res) => {
  const order = await OrderDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!order || order.deleted) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

// Edit an order's items/remark — pending only. Once confirmed or cancelled,
// an order is a record of what happened and shouldn't be silently rewritten;
// staff who need to change a confirmed order should cancel it and create a
// new one (keeps the audit trail honest). Same admin+staff access as create.
app.put('/api/orders/:id', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const order = await OrderDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.role === 'staff' && order.staffId !== req.user.id)
    return res.status(403).json({ error: 'You can only edit your own orders' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Only pending orders can be edited' });

  const { items, remark, exhibitionId, customFields } = req.body;
  const updates = {};
  if (items !== undefined) {
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one item is required' });
    const { lineItems, fieldTotals } = await buildOrderLines(req.tenant, items);
    if (!lineItems.length) return res.status(400).json({ error: 'No valid items in this order' });
    updates.items = lineItems;
    updates.fieldTotals = fieldTotals;
  }
  if (remark !== undefined) updates.remark = remark;
  if (exhibitionId !== undefined) updates.exhibitionId = exhibitionId;
  if (customFields !== undefined) updates.customFields = normalizeCustomFields(req.tenant.orderCustomFields || [], customFields);

  await OrderDB.update({ id: req.params.id, tenantId: req.tenant.id }, updates);
  logAudit(req, 'order.update', 'order', req.params.id, { orderNo: order.orderNo, itemCount: updates.items?.length });
  res.json({ ok: true });
});

app.put('/api/orders/:id/status', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const before = await OrderDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  await OrderDB.update({ id: req.params.id, tenantId: req.tenant.id }, { status });
  logAudit(req, 'order.status_change', 'order', req.params.id, { from: before?.status, to: status });
  res.json({ ok: true });
});

// Soft delete — kept in the database for audit/history, just hidden from
// every normal view (list, reports, the buyer's own share link). Admin-only.
app.delete('/api/orders/:id', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const order = await OrderDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  await OrderDB.remove({ id: req.params.id, tenantId: req.tenant.id });
  logAudit(req, 'order.delete', 'order', req.params.id, { orderNo: order.orderNo });
  res.json({ ok: true });
});

// Public — no auth, no tenant header required. shareToken is a random uuid so it
// doubles as the access secret; the order's own tenant is looked up from it so the
// client-facing page can render the company name/logo without logging in.
app.get('/api/orders/public/:token', async (req, res) => {
  const order = await OrderDB.findOne({ shareToken: req.params.token });
  if (!order || order.deleted) return res.status(404).json({ error: 'Order not found' });
  const tenant = await TenantDB.findOne({ id: order.tenantId });
  // Order View Layout is live, not frozen at order-creation time — unlike
  // orderFieldsSnapshot (which preserves what was actually collected on the
  // order and must stay historically accurate), the column layout is pure
  // display config. Changing it in Settings should apply to every order's
  // shared link immediately, old and new — that's the whole point of it
  // being a "layout", not a record of what happened.
  const columns = (tenant?.orderViewColumns && tenant.orderViewColumns.length) ? tenant.orderViewColumns : (order.columnsSnapshot || []);
  // Resolves each configured header/footer field spec into the actual
  // label + value for THIS order — an "orderfield" reads from this order's
  // own customFields; a "total" reads from this order's own fieldTotals
  // (with the field's unit/decimals attached so the client formats it the
  // same way it formats every other number). Entries with no value for this
  // particular order are dropped rather than shown blank.
  function resolveFieldList(specs) {
    return (specs || []).map(spec => {
      if (spec.type === 'orderfield') {
        const val = order.customFields?.[spec.fieldKey];
        return { label: spec.label, value: val ?? '' };
      }
      const val = order.fieldTotals?.[spec.fieldKey];
      const meta = (order.orderFieldsSnapshot || []).find(f => f.key === spec.fieldKey);
      return { label: spec.label, value: val ?? '', unit: meta?.unit, decimals: meta?.decimals };
    }).filter(f => f.value !== '' && f.value !== undefined && f.value !== null);
  }
  const viewHeaderFields = resolveFieldList(tenant?.orderViewHeaderFields);
  const viewFooterFields = resolveFieldList(tenant?.orderViewFooterFields);
  // Only send fields the company actually chose to publish — never leak a
  // GST number or phone that was entered but left toggled off.
  const rawFooter = tenant?.footer || { show: {} };
  const footer = {};
  for (const key of FOOTER_TEXT_FIELDS) if (rawFooter.show?.[key] && rawFooter[key]) footer[key] = rawFooter[key];
  const showLogo = !!(rawFooter.show?.logo && tenant?.logoUrl);
  res.json({
    order: { ...order, columnsSnapshot: columns },
    company: { name: tenant?.name, logoUrl: showLogo ? tenant.logoUrl : '', footer },
    // Live like the column layout, not frozen at order-creation time — same
    // reasoning: this is a display method AuroCircle chose for the client,
    // not a record of what happened on that specific order.
    rowGrouping: tenant?.orderRowGrouping || 'none',
    viewHeaderFields, viewFooterFields,
  });
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
  await ExhibitionDB.remove({ id: req.params.id, tenantId: req.tenant.id });
  logAudit(req, 'exhibition.delete', 'exhibition', req.params.id);
  res.json({ ok: true });
});

// ── REPORTS ───────────────────────────────────────────────────────────────────
// Computed in application code (not a DB aggregation pipeline) so the same logic
// works identically against MongoDB and the lowdb fallback.
// Shared by the tenant-scoped report routes and the platform-admin
// equivalent below — single-sourced so the numbers can never disagree
// between what a company admin sees and what the platform admin sees.
async function getReportsForTenant(tenantId) {
  const orders = (await OrderDB.find({ tenantId })).filter(o => !o.deleted);
  const byParty = {}, byItem = {}, byStaff = {};
  for (const o of orders) {
    byParty[o.partyId] ??= { partyId: o.partyId, partyName: o.partyName, partyPhone: o.partyPhone, orderCount: 0 };
    byParty[o.partyId].orderCount += 1;
    byStaff[o.staffId] ??= { staffId: o.staffId, staffName: o.staffName, orderCount: 0 };
    byStaff[o.staffId].orderCount += 1;
    for (const line of o.items || []) {
      byItem[line.itemId] ??= { itemId: line.itemId, label: line.label, scannerCode: line.scannerCode, qty: 0 };
      byItem[line.itemId].qty += line.qty;
    }
  }
  return {
    byParty: Object.values(byParty).sort((a, b) => b.orderCount - a.orderCount),
    byItem: Object.values(byItem).sort((a, b) => b.qty - a.qty),
    byStaff: Object.values(byStaff).sort((a, b) => b.orderCount - a.orderCount),
  };
}

app.get('/api/reports/party-wise', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  res.json((await getReportsForTenant(req.tenant.id)).byParty);
});

app.get('/api/reports/item-wise', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  res.json((await getReportsForTenant(req.tenant.id)).byItem);
});

app.get('/api/reports/staff-wise', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  res.json((await getReportsForTenant(req.tenant.id)).byStaff);
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

// Free Render tiers don't include Shell access, so `node db/seed-platform-admin.js`
// isn't runnable there. This gives the same result through something free
// tiers do support: Environment variables. Set PLATFORM_ADMIN_EMAIL and
// PLATFORM_ADMIN_PASSWORD in Render's Environment tab, redeploy, and the
// account is created (or its password updated) automatically on boot — no
// Shell, no HTTP endpoint (so it can't be triggered by an unauthenticated
// request; only someone who already has full control of the Render service's
// env vars can use this, the same trust level Shell access would have had).
async function ensurePlatformAdminFromEnv() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (password.length < 8) { log.warn('PLATFORM_ADMIN_PASSWORD is too short (8+ chars) — skipped auto-provisioning'); return; }
  const name = process.env.PLATFORM_ADMIN_NAME || 'Platform Admin';
  const hashed = bcrypt.hashSync(password, 10);
  const existing = await PlatformAdminDB.findOne({ email });
  if (existing) {
    await PlatformAdminDB.update({ id: existing.id }, { password: hashed, name });
    log.info({ email }, 'Platform admin auto-provisioned from env vars (updated)');
  } else {
    await PlatformAdminDB.create({ id: uuid(), email, password: hashed, name, createdAt: new Date().toISOString() });
    log.info({ email }, 'Platform admin auto-provisioned from env vars (created)');
  }
}

// One-time backfill for companies created before this change: FIXED_FIELDS
// is only ever seeded at company-creation time, so existing tenants won't
// pick up a renamed or newly-added fixed field on their own. Idempotent —
// safe to run on every boot, only touches what's actually missing/stale.
async function migrateFixedFields() {
  const tenants = await TenantDB.find({});
  for (const tenant of tenants) {
    const existing = await FieldDefDB.find({ tenantId: tenant.id });
    const byKey = {}; existing.forEach(f => { byKey[f.key] = f; });
    let maxOrder = existing.reduce((m, f) => Math.max(m, f.order ?? 0), -1);
    for (const def of FIXED_FIELDS) {
      const current = byKey[def.key];
      if (!current) {
        maxOrder += 1;
        await FieldDefDB.create({ id: uuid(), tenantId: tenant.id, order: maxOrder, active: true, options: [], createdAt: new Date().toISOString(), ...def });
        log.info({ tenant: tenant.slug, field: def.key }, 'Backfilled missing fixed field');
      } else if (current.label !== def.label || current.required !== !!def.required) {
        await FieldDefDB.update({ id: current.id }, { label: def.label, required: !!def.required });
      }
    }
  }
}

// Companies created before settingsPermissions defaulted to deny (see the
// tenant schema comment) still have their old default-OPEN values sitting
// in the database — flipping the schema default only affects NEW documents,
// it doesn't retroactively touch ones already written. A missing
// itemMasterFields key is a reliable signal a tenant predates this model
// entirely (that key didn't exist before), so those get reset to fully
// closed — matching what every tenant created since would have gotten.
async function migrateSettingsPermissionsDefault() {
  const tenants = await TenantDB.find({});
  const closed = { companyName: false, orderForm: false, orderDetailsFields: false, orderViewLayout: false, itemMasterFields: false, orderFooter: false };
  for (const tenant of tenants) {
    if (tenant.settingsPermissions?.itemMasterFields === undefined) {
      await TenantDB.update({ id: tenant.id }, { settingsPermissions: closed });
      log.info({ tenant: tenant.slug }, 'Migrated pre-default-deny company to closed settings permissions');
    }
  }
}

connectDB().then(async () => {
  initR2();
  await ensurePlatformAdminFromEnv();
  await migrateFixedFields();
  await migrateSettingsPermissionsDefault();
  app.listen(PORT, () => log.info({ port: PORT, version: APP_VERSION, builtAt: BUILD_TIME }, 'Expo Orders running'));
}).catch(err => {
  log.fatal({ err }, 'Failed to connect to database');
  process.exit(1);
});
