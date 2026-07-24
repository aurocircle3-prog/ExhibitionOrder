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
// Builds a link on the COMPANY's own subdomain (meridian.expoorders.com),
// not the bare platform domain — the whole point of subdomains being that
// a buyer's order link or an admin's setup link should look like it's
// coming from that specific company, not a generic shared host. Falls
// back to whatever host the request actually came in on if APP_URL isn't
// configured for production yet (e.g. local dev, or before the domain's
// wired up) — same reasoning as the existing fallback these replaced.
function tenantBaseUrl(req, tenant) {
  if (process.env.APP_URL && process.env.APP_URL !== 'http://localhost:3000') {
    const u = new URL(APP_URL);
    return `${u.protocol}//${tenant.slug}.${u.host}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}
// Bumped by hand for meaningful releases; BUILD_TIME is set fresh in every
// delivered update — the fast, foolproof way to check "did my last deploy
// actually go live" is to compare this against when you think you pushed.
const APP_VERSION  = '1.52.0';
const BUILD_TIME   = '2026-07-23T14:15:59Z';

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

// ── EMAIL (Brevo HTTP API — plain https POST, no SMTP ports needed on Render) ──
const BREVO_API_KEY     = process.env.BREVO_API_KEY || '';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'orders@expoorders.com';
const BREVO_SENDER_NAME  = process.env.BREVO_SENDER_NAME || 'Expo Orders';
const useEmail = !!BREVO_API_KEY;
if (!useEmail) log.warn('BREVO_API_KEY not set — order notification emails are disabled');

// Fires one email via Brevo's transactional send endpoint. Always resolves
// (never throws) — a failed send should never take down whatever request
// triggered it; the caller just logs and moves on.
function sendEmail({ to, toName, subject, html }) {
  if (!useEmail || !to) return Promise.resolve({ skipped: true });
  const payload = JSON.stringify({
    sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
    to: [{ email: to, name: toName || undefined }],
    subject, htmlContent: html,
  });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': BREVO_API_KEY, 'content-length': Buffer.byteLength(payload) },
    }, resp => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (resp.statusCode >= 300) log.error({ to, status: resp.statusCode, body: data }, 'Brevo email send failed');
        resolve({ ok: resp.statusCode < 300 });
      });
    });
    req.on('error', err => { log.error({ err, to }, 'Brevo email request failed'); resolve({ ok: false }); });
    req.write(payload);
    req.end();
  });
}

// Fire-and-forget both order-notification emails — never awaited by the
// route that calls this, so a slow or failing email provider can't delay
// or break the actual order-creation response. Company gets one if its
// admin has an email on file (always true — required at signup); the
// buyer gets one only if they have an email on file (optional field).
async function sendOrderEmails(tenant, order, party, baseUrl) {
  if (!useEmail) return;
  const shareUrl = `${baseUrl}/order/${order.shareToken}`;
  const itemCount = order.items.length;
  const admin = await UserDB.findOne({ tenantId: tenant.id, role: 'admin' });
  if (admin?.email) {
    sendEmail({
      to: admin.email, toName: admin.name,
      subject: `New order ${order.orderNo} — ${party.firmName}`,
      html: `<p>New order <b>${escHtml(order.orderNo)}</b> from <b>${escHtml(party.firmName)}</b> (${escHtml(party.phone || '')}).</p>
        <p>${itemCount} item${itemCount === 1 ? '' : 's'}${order.remark ? ` — Note: ${escHtml(order.remark)}` : ''}</p>
        <p><a href="${shareUrl}">View order</a></p>`,
    }).catch(err => log.error({ err }, 'Order admin-notification email failed'));
  }
  if (party.email) {
    sendEmail({
      to: party.email, toName: party.firmName,
      subject: `Your order ${order.orderNo} from ${tenant.name}`,
      html: `<p>Hi ${escHtml(party.contactPerson || party.firmName)},</p>
        <p>Your order <b>${escHtml(order.orderNo)}</b> with <b>${escHtml(tenant.name)}</b> has been received (${itemCount} item${itemCount === 1 ? '' : 's'}).</p>
        <p><a href="${shareUrl}">View your order</a></p>`,
    }).catch(err => log.error({ err }, 'Order buyer-notification email failed'));
  }
}
// Minimal HTML escape for values dropped into email bodies — party/company
// names and remarks are free text, and this goes out as real HTML mail.
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ── MONGOOSE SCHEMAS ──────────────────────────────────────────────────────────
const tenantSchema = new mongoose.Schema({
  id: String,
  name: String,                       // "Meridian Traders"
  slug: { type: String, unique: true, sparse: true }, // "meridian" -> meridian.orders.is
  natureOfBusiness: { type: String, default: '' }, // e.g. "Jewelry Wholesaler" — helps platform admin pick relevant companies when assigning exhibition participants
  plan: { type: String, default: 'free' },
  logoUrl: String,
  // Variant tags — off by default, invisible to every existing jewelry
  // client. Turned on per company by platform admin for catalogs where a
  // style comes in multiple variations (garments: Color, Size, Material —
  // but not hardcoded to those; platform admin names and defines however
  // many categories this specific company needs). Each category's value
  // list is ORDERED — chip display order in Take Order and Item Master
  // follows this list, not alphabetical.
  enableVariants: { type: Boolean, default: false },
  variantCategories: { type: [{ key: String, label: String, values: [String] }], default: [] },
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
      // Free-text lines the company admin can fill in (terms, a delivery
      // note, anything not covered by the structured fields above). Show
      // toggle is platform-admin only — see PLATFORM_ONLY_SHOW_KEYS.
      note1: String, note2: String,
      show: {
        type: {
          logo: { type: Boolean, default: false }, address: { type: Boolean, default: false },
          gstNumber: { type: Boolean, default: false }, whatsappNumber: { type: Boolean, default: false },
          instagram: { type: Boolean, default: false }, facebook: { type: Boolean, default: false },
          twitter: { type: Boolean, default: false }, youtube: { type: Boolean, default: false }, website: { type: Boolean, default: false },
          note1: { type: Boolean, default: false }, note2: { type: Boolean, default: false },
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
  // Which values this specific style is available in, per variant
  // category — keyed by category key, e.g. {color: ['Red','Blue'], size:
  // ['S','M']}. An empty or missing array for a category means "all of
  // that category's values" (the common case — most styles come in the
  // company's full range, only some need narrowing down).
  variantSelections: { type: mongoose.Schema.Types.Mixed, default: {} },
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

// Platform-level — not owned by any one tenant. AuroCircle creates these
// centrally (a real trade show, e.g. "Mumbai Jewellery Show 2026") and
// assigns companies into them via ExhibitionParticipant below. Every
// company's actual items/orders stay fully private; this is purely the
// shared "what event is this" label they're grouped under.
const exhibitionSchema = new mongoose.Schema({
  id: String,
  name: String, location: String, startDate: String, endDate: String,
  active: { type: Boolean, default: true },
  createdAt: { type: String, default: () => new Date().toISOString() },
});

// Which companies are in which exhibitions, and until when. Bulk-adding a
// batch of companies to an exhibition gives them all the same validTill by
// default, but each one can be edited individually afterward (e.g. one
// client paid for a longer window than the rest).
const exhibitionParticipantSchema = new mongoose.Schema({
  id: String, exhibitionId: String, tenantId: String,
  validTill: String, // date, platform-admin-controlled — expired means no new items/orders in this exhibition, but past data stays visible
  closed: { type: Boolean, default: false }, // company admin's own manual close/reopen — independent of validTill, private to this company only
  // Order numbering for this company's orders within this exhibition —
  // client-admin configured, not platform admin, since each company wants
  // its own scheme (a shared exhibition's order numbers are never mixed
  // across companies anyway, they're already tenant-scoped). orderSeq is
  // the running counter, separate per participant so two exhibitions for
  // the same company don't share one sequence.
  orderNumberPrefix: { type: String, default: 'EX' },
  orderNumberSuffix: { type: String, default: '' },
  orderNumberStart: { type: Number, default: 1000 },
  orderNumberSeq: { type: Number, default: null },
  addedAt: { type: String, default: () => new Date().toISOString() },
});

// Platform-admin-authored, per-tenant custom report. rowType decides
// whether the computed report has one row per order line item (detail) or
// one row per order (summary, with numeric columns/formulas summed across
// that order's items — same principle as "Show total" on Order View
// Layout columns). Columns are Mixed, not a strict sub-schema, for the
// same reason orderViewColumns is — different column types carry
// different fields, and a strict schema has silently stripped
// unrecognized fields before (see orderFieldsSnapshot's decimals bug).
const reportDefSchema = new mongoose.Schema({
  id: String, tenantId: String, name: String,
  rowType: { type: String, default: 'item' }, // 'item' | 'order'
  columns: { type: [mongoose.Schema.Types.Mixed], default: [] },
  createdAt: { type: String, default: () => new Date().toISOString() },
});

const Tenant     = mongoose.model('Tenant', tenantSchema);
const User       = mongoose.model('User', userSchema);
const FieldDef   = mongoose.model('FieldDef', fieldDefSchema);
const Item       = mongoose.model('Item', itemSchema);
const Party      = mongoose.model('Party', partySchema);
const Order      = mongoose.model('Order', orderSchema);
const Exhibition = mongoose.model('Exhibition', exhibitionSchema);
const ExhibitionParticipant = mongoose.model('ExhibitionParticipant', exhibitionParticipantSchema);
const ReportDef  = mongoose.model('ReportDef', reportDefSchema);
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
    db.defaults({ tenants: [], users: [], fielddefs: [], items: [], parties: [], orders: [], exhibitions: [], exhibitionParticipants: [], reportDefs: [], auditlogs: [], imagesets: [], platformadmins: [], passwordsetuptokens: [] }).write();
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
const ExhibitionParticipantDB = makeCollectionOps(ExhibitionParticipant, 'exhibitionParticipants', { addedAt: -1 });
const ReportDefDB = makeCollectionOps(ReportDef, 'reportDefs', { createdAt: -1 });
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
// then the request's subdomain (meridian.orders.is -> slug "meridian") in production.
// Shared hosting platforms hand out <service>.onrender.com-style URLs that are
// structurally identical to a real per-company subdomain — skip those known
// platform hosts so a Render/Vercel/etc. deployment isn't mistaken for a tenant.
const PLATFORM_HOST_SUFFIXES = ['onrender.com', 'vercel.app', 'netlify.app', 'herokuapp.com'];
// Shared by resolveTenant (for API requests) and the root route (to decide
// marketing page vs. straight-to-login) — a request's hostname implies a
// company subdomain if it's not a known generic hosting host, not
// localhost, has 3+ dot-separated parts, and isn't "www".
function detectSubdomainSlug(req) {
  const host = (req.hostname || '').toLowerCase();
  const onPlatformHost = PLATFORM_HOST_SUFFIXES.some(suf => host.endsWith(suf)) || host === 'localhost';
  const parts = host.split('.');
  if (!onPlatformHost && parts.length > 2 && parts[0] !== 'www') return parts[0];
  return null;
}
async function resolveTenant(req, res, next) {
  let slug = req.headers['x-tenant-slug'] || req.query.tenant;
  if (!slug) slug = detectSubdomainSlug(req);
  if (!slug) return res.status(400).json({ error: 'Company not specified. Use the company subdomain, or pass ?tenant=slug / X-Tenant-Slug header.' });
  const tenant = await TenantDB.findOne({ slug: String(slug).toLowerCase() });
  if (!tenant) return res.status(404).json({ error: `No company found for "${slug}"` });
  if (tenant.active === false) return res.status(403).json({ error: 'This company account is currently inactive. Contact ExpoOrders for help.' });
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
    return { id: t.id, name: t.name, slug: t.slug, natureOfBusiness: t.natureOfBusiness || '', plan: t.plan, active: t.active !== false, createdAt: t.createdAt, userCount, itemCount, orderCount, partyCount };
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
    ExhibitionParticipantDB.count({ tenantId: tenant.id }),
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
  const { companyName, slug: rawSlug, adminName, email, phone, maxStaff, natureOfBusiness, cloneFromTenantId } = req.body;
  if (!companyName || !rawSlug || !adminName || !email)
    return res.status(400).json({ error: 'Company name, link, admin name, and email are all required' });
  const slug = normalizeSlug(rawSlug);
  const slugErr = validateSlug(slug);
  if (slugErr) return res.status(400).json({ error: slugErr });
  if (await TenantDB.findOne({ slug })) return res.status(400).json({ error: 'That company link name is already taken' });

  // Optional starting point: copy another company's CONFIGURATION onto this
  // brand-new one — the tedious stuff to set up from scratch (Item Master
  // fields, Order Form, variant categories, Order View Layout, settings
  // permissions) — so two companies in the same industry (e.g. two jewelry
  // exhibitors) don't each need identical setup done by hand. Deliberately
  // narrow: never copies anything that identifies or contacts the SOURCE
  // company itself (name, slug, logo, address, GST, phone, socials, staff
  // cap) — those stay blank/default on the new company either way.
  let template = null;
  if (cloneFromTenantId) {
    template = await TenantDB.findOne({ id: cloneFromTenantId });
    if (!template) return res.status(400).json({ error: 'Company to copy settings from was not found' });
  }

  const tenant = {
    id: uuid(), name: companyName, slug, natureOfBusiness: natureOfBusiness || '', plan: 'free', orderSeq: 1000, createdAt: new Date().toISOString(),
    maxStaff: maxStaff !== undefined && maxStaff !== '' ? Number(maxStaff) : null,
    settingsPermissions: template?.settingsPermissions || { companyName: false, orderForm: false, orderDetailsFields: false, orderViewLayout: false, itemMasterFields: false, orderFooter: false },
  };
  if (template) {
    tenant.enableVariants = template.enableVariants || false;
    tenant.variantCategories = template.variantCategories || [];
    tenant.orderFields = template.orderFields || [];
    tenant.orderShowImages = template.orderShowImages !== false;
    tenant.orderRowGrouping = template.orderRowGrouping || 'none';
    tenant.orderCustomFields = template.orderCustomFields || [];
    tenant.orderViewColumns = template.orderViewColumns || [];
    tenant.orderViewHeaderFields = template.orderViewHeaderFields || [];
    tenant.orderViewFooterFields = template.orderViewFooterFields || [];
    // Only the reusable boilerplate text/policy pieces of the footer — never
    // the source company's own address/GST/phone/socials/logo, which are
    // that company's identity, not a "setting".
    tenant.footer = {
      whatsappMessage: template.footer?.whatsappMessage || '',
      note1: template.footer?.note1 || '', note2: template.footer?.note2 || '',
      show: { note1: !!template.footer?.show?.note1, note2: !!template.footer?.show?.note2 },
    };
  }
  await TenantDB.create(tenant);

  for (let i = 0; i < FIXED_FIELDS.length; i++) {
    await FieldDefDB.create({ id: uuid(), tenantId: tenant.id, order: i, active: true, options: [], createdAt: new Date().toISOString(), ...FIXED_FIELDS[i] });
  }
  // Copy the source company's own custom Item Master fields (everything
  // past the two always-present fixed fields), preserving their order.
  if (template) {
    const templateFields = (await FieldDefDB.find({ tenantId: template.id, active: true })).filter(f => !f.fixed).sort((a, b) => a.order - b.order);
    for (let i = 0; i < templateFields.length; i++) {
      const { id: _oldId, tenantId: _oldTenant, createdAt: _oldCreatedAt, ...rest } = templateFields[i];
      await FieldDefDB.create({ ...rest, id: uuid(), tenantId: tenant.id, order: FIXED_FIELDS.length + i, createdAt: new Date().toISOString() });
    }
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
  const baseUrl = tenantBaseUrl(req, tenant);

  log.info({ tenant: tenant.slug, admin: admin.email, platformAdmin: req.platformAdmin.email, clonedFrom: template?.slug || null }, 'Platform admin created a company');
  res.json({ tenant, admin: { id: admin.id, name: admin.name, email: admin.email }, setupLink: `${baseUrl}/set-password.html?token=${setupToken}`, clonedFrom: template ? { id: template.id, name: template.name } : null });
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

app.put('/api/platform/tenants/:id/business-info', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const updates = {};
  if (req.body.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body.natureOfBusiness !== undefined) updates.natureOfBusiness = String(req.body.natureOfBusiness).trim();
  await TenantDB.update({ id: tenant.id }, updates);
  res.json({ ok: true });
});

// Colors/sizes (variants) — off by default, invisible to every existing
// jewelry client. Turning it on for a company unlocks the color/size
// pickers in that company's own Item Master and the chip-based entry flow
// in Take Order; every other company is completely unaffected.
app.put('/api/platform/tenants/:id/variants-config', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const enableVariants = !!req.body.enableVariants;
  let variantCategories = tenant.variantCategories || [];
  try {
    if (Array.isArray(req.body.categories)) {
      const usedKeys = new Set();
      variantCategories = req.body.categories.map((c, i) => {
        const label = String(c.label || '').trim();
        if (!label) throw Object.assign(new Error('Every category needs a name'), { status: 400 });
        let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `category_${i}`;
        while (usedKeys.has(key)) key = key + '_2'; // two categories reducing to the same key (e.g. "Size" and "size!") — keep both, just disambiguate
        usedKeys.add(key);
        const values = Array.isArray(c.values) ? [...new Set(c.values.map(v => String(v).trim()).filter(Boolean))] : [];
        return { key, label, values };
      });
    }
  } catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  await TenantDB.update({ id: tenant.id }, { enableVariants, variantCategories });
  res.json({ ok: true, enableVariants, variantCategories });
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
    PartyDB.remove({ tenantId }), OrderDB.remove({ tenantId }), ExhibitionParticipantDB.remove({ tenantId }),
    AuditLogDB.remove({ tenantId }), ImageSetDB.remove({ tenantId }), PasswordSetupTokenDB.remove({ tenantId }),
  ]);
  await deleteTenantFiles(tenantId);
  await TenantDB.remove({ id: tenantId });

  log.warn({ tenant: tenant.slug, tenantId, platformAdmin: req.platformAdmin.email }, 'Platform admin permanently deleted a company and all its data');
  res.json({ ok: true });
});

// ── Exhibitions (platform-level) ─────────────────────────────────────────
// AuroCircle creates these centrally and assigns companies into them —
// companies can no longer create their own (see the removed /api/exhibitions
// POST/PUT/DELETE routes above; company admins only get the read-only list
// of what they've been added to).
// ── Custom reports (platform-admin authored, per tenant) ─────────────────
app.get('/api/platform/tenants/:id/custom-reports', platformAuth, async (req, res) => {
  const reports = await ReportDefDB.find({ tenantId: req.params.id });
  res.json(reports);
});
app.post('/api/platform/tenants/:id/custom-reports', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Report name is required' });
  const rowType = req.body.rowType === 'order' ? 'order' : 'item';
  try {
    const fieldDefs = await FieldDefDB.find({ tenantId: tenant.id, active: true });
    const orderCustomFields = tenant.orderCustomFields || [];
    const columns = validateReportColumns(req.body.columns, rowType, fieldDefs, orderCustomFields, tenant.variantCategories);
    const report = { id: uuid(), tenantId: tenant.id, name, rowType, columns, createdAt: new Date().toISOString() };
    await ReportDefDB.create(report);
    res.json(report);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
app.put('/api/platform/tenants/:id/custom-reports/:reportId', platformAuth, async (req, res) => {
  const tenant = await TenantDB.findOne({ id: req.params.id });
  if (!tenant) return res.status(404).json({ error: 'Company not found' });
  const report = await ReportDefDB.findOne({ id: req.params.reportId, tenantId: tenant.id });
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Report name is required' });
  const rowType = req.body.rowType === 'order' ? 'order' : 'item';
  try {
    const fieldDefs = await FieldDefDB.find({ tenantId: tenant.id, active: true });
    const orderCustomFields = tenant.orderCustomFields || [];
    const columns = validateReportColumns(req.body.columns, rowType, fieldDefs, orderCustomFields, tenant.variantCategories);
    await ReportDefDB.update({ id: report.id }, { name, rowType, columns });
    res.json({ ok: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
app.delete('/api/platform/tenants/:id/custom-reports/:reportId', platformAuth, async (req, res) => {
  await ReportDefDB.remove({ id: req.params.reportId, tenantId: req.params.id });
  res.json({ ok: true });
});

app.get('/api/platform/exhibitions', platformAuth, async (req, res) => {
  const exhibitions = await ExhibitionDB.find({});
  const participants = await ExhibitionParticipantDB.find({});
  const countByExhibition = {};
  participants.forEach(p => { countByExhibition[p.exhibitionId] = (countByExhibition[p.exhibitionId] || 0) + 1; });
  const result = exhibitions.map(e => ({ ...e, participantCount: countByExhibition[e.id] || 0 }));
  result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(result);
});
app.post('/api/platform/exhibitions', platformAuth, async (req, res) => {
  const { name, location, startDate, endDate } = req.body;
  if (!name) return res.status(400).json({ error: 'Exhibition name is required' });
  const exhibition = { id: uuid(), name, location: location || '', startDate: startDate || '', endDate: endDate || '', active: true, createdAt: new Date().toISOString() };
  await ExhibitionDB.create(exhibition);
  res.json(exhibition);
});
app.put('/api/platform/exhibitions/:id', platformAuth, async (req, res) => {
  const updates = {};
  ['name', 'location', 'startDate', 'endDate', 'active'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  await ExhibitionDB.update({ id: req.params.id }, updates);
  res.json({ ok: true });
});
// Removes the exhibition and every company's participation in it. Doesn't
// touch the items/orders companies already created inside it — those stay
// exactly as they are, just no longer tagged to a live exhibition. Full
// cascade cleanup of that data is a deliberately separate, later step, not
// bundled into this since it's a much bigger, more destructive action.
app.delete('/api/platform/exhibitions/:id', platformAuth, async (req, res) => {
  await ExhibitionParticipantDB.remove({ exhibitionId: req.params.id });
  await ExhibitionDB.remove({ id: req.params.id });
  res.json({ ok: true });
});

// Which companies are in this exhibition, with each one's validTill and
// enough tenant info (name, nature of business) to make sense of the list.
app.get('/api/platform/exhibitions/:id/participants', platformAuth, async (req, res) => {
  const participants = await ExhibitionParticipantDB.find({ exhibitionId: req.params.id });
  const tenants = await TenantDB.find({});
  const tenantById = {}; tenants.forEach(t => { tenantById[t.id] = t; });
  const result = participants.map(p => {
    const t = tenantById[p.tenantId];
    return { participantId: p.id, tenantId: p.tenantId, tenantName: t?.name || '(deleted company)', natureOfBusiness: t?.natureOfBusiness || '', validTill: p.validTill, addedAt: p.addedAt };
  });
  result.sort((a, b) => a.tenantName.localeCompare(b.tenantName));
  res.json(result);
});
// Bulk-add — a batch of companies all get the same validTill by default;
// each can be edited individually afterward via the PUT route below.
// Companies already in this exhibition are left untouched, not duplicated.
app.post('/api/platform/exhibitions/:id/participants', platformAuth, async (req, res) => {
  const exhibition = await ExhibitionDB.findOne({ id: req.params.id });
  if (!exhibition) return res.status(404).json({ error: 'Exhibition not found' });
  const tenantIds = Array.isArray(req.body.tenantIds) ? [...new Set(req.body.tenantIds.filter(Boolean))] : [];
  if (!tenantIds.length) return res.status(400).json({ error: 'No companies selected' });
  const validTill = req.body.validTill || '';
  const existing = await ExhibitionParticipantDB.find({ exhibitionId: req.params.id });
  const alreadyIn = new Set(existing.map(p => p.tenantId));
  let added = 0;
  for (const tenantId of tenantIds) {
    if (alreadyIn.has(tenantId)) continue;
    await ExhibitionParticipantDB.create({ id: uuid(), exhibitionId: req.params.id, tenantId, validTill, addedAt: new Date().toISOString() });
    added++;
  }
  res.json({ ok: true, added, skipped: tenantIds.length - added });
});
app.put('/api/platform/exhibitions/:id/participants/:tenantId', platformAuth, async (req, res) => {
  await ExhibitionParticipantDB.update({ exhibitionId: req.params.id, tenantId: req.params.tenantId }, { validTill: req.body.validTill || '' });
  res.json({ ok: true });
});
app.delete('/api/platform/exhibitions/:id/participants/:tenantId', platformAuth, async (req, res) => {
  await ExhibitionParticipantDB.remove({ exhibitionId: req.params.id, tenantId: req.params.tenantId });
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
  res.json({ ok: true, footer: await saveFooterForTenant(tenant.id, req.body, { isPlatform: true }) });
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
  const categoryHeaders = tenant.enableVariants ? (tenant.variantCategories || []).map(c => `${c.label} (comma-separated: ${c.values.join(', ')}) *`) : [];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[...headers, ...categoryHeaders]]);
  ws['!cols'] = [...headers, ...categoryHeaders].map(() => ({ wch: 22 }));
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
  res.status(403).json({ error: 'New companies are set up by ExpoOrders directly — get in touch to get started.' });
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
      return res.status(400).json({ error: `Staff limit reached (${req.tenant.maxStaff}). Contact ExpoOrders to increase it.` });
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
      return res.status(403).json({ error: 'This setting is managed by ExpoOrders for your account — contact us to change it.' });
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
  const orderCustomFields = tenant.orderCustomFields || [];
  const allowedOrderFieldKeys = new Set(orderCustomFields.map(f => f.key));
  // Formulas can only meaningfully use numeric fields — a text field like
  // "Category" can't be multiplied. Numeric Order Detail fields (one value
  // per order, e.g. a Wastage % set once) are just as valid to use as Item
  // Master fields — the same value just applies across every row's formula.
  const allowedFormulaNames = new Set([
    ...fieldDefs.filter(f => f.type === 'number').map(f => f.key),
    ...orderCustomFields.filter(f => f.type === 'number').map(f => f.key),
    'qty',
  ]);

  const columns = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (!raw || !['images', 'field', 'formula', 'serial', 'remark', 'orderfield', 'itemcode', 'qty', 'varianttag'].includes(raw.type)) {
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
      if (f.type === 'number') col.showTotal = !!raw.showTotal;
    } else if (raw.type === 'varianttag') {
      const cat = (tenant.variantCategories || []).find(c => c.key === raw.fieldKey);
      if (!cat) throw Object.assign(new Error(`"${raw.fieldKey}" isn't one of this company's variant tags — add it in Extra Tags first`), { status: 400 });
      col.fieldKey = raw.fieldKey;
      col.label = (raw.label || cat.label || '').trim().slice(0, 60) || cat.label;
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
      col.showTotal = !!raw.showTotal;
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
  // Order Details field, or a "total" referencing one of THIS SAME save's
  // columns that has showTotal on — by column id, not field key, since a
  // formula column doesn't have a field key of its own to point at.
  const totalableColumns = columns.filter(c => c.showTotal);
  function validateFieldList(list) {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      if (!raw || !['orderfield', 'total', 'fieldtotal'].includes(raw.type)) throw Object.assign(new Error('Each field needs a valid type'), { status: 400 });
      if (raw.type === 'orderfield') {
        if (!allowedOrderFieldKeys.has(raw.fieldKey)) throw Object.assign(new Error(`"${raw.fieldKey}" isn't one of the Order Details fields — add it there first`), { status: 400 });
        const f = orderCustomFields.find(x => x.key === raw.fieldKey);
        out.push({ type: 'orderfield', fieldKey: raw.fieldKey, label: (raw.label || f.label || '').trim().slice(0, 60) || f.label });
      } else if (raw.type === 'fieldtotal') {
        // Totals a numeric Item Master field directly, across every item on
        // the order — doesn't require that field to be a visible column in
        // the table at all, unlike the column-based "total" type below.
        const f = fieldByKey[raw.fieldKey];
        if (!f || f.type !== 'number') throw Object.assign(new Error(`"${raw.fieldKey}" isn't a numeric Item Master field`), { status: 400 });
        out.push({ type: 'fieldtotal', fieldKey: raw.fieldKey, unit: f.unit || '', decimals: f.decimals ?? 2, label: (raw.label || `Total ${f.label}`).trim().slice(0, 60) || `Total ${f.label}` });
      } else { // total — fieldKey here means "column id"
        const col = totalableColumns.find(c => c.id === raw.fieldKey);
        if (!col) throw Object.assign(new Error(`That column isn't marked "Show total" — turn that on for a column in Order View Layout first`), { status: 400 });
        out.push({ type: 'total', fieldKey: raw.fieldKey, label: (raw.label || `Total ${col.label}`).trim().slice(0, 60) || `Total ${col.label}` });
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
// note1/note2 are free-text lines a company admin can fill in for anything
// not covered by the structured fields (terms, a delivery note, etc.) —
// unlike every other field here, their show/hide toggle is platform-admin
// only: the client can write the text, but AuroCircle decides whether it
// actually goes live on the public link (a lightweight review gate on
// freeform text, which the structured fields don't need).
const FOOTER_TEXT_FIELDS = ['address', 'gstNumber', 'whatsappNumber', 'instagram', 'facebook', 'twitter', 'youtube', 'website', 'whatsappMessage', 'note1', 'note2'];
const FOOTER_SHOW_KEYS = ['logo', ...FOOTER_TEXT_FIELDS];
const PLATFORM_ONLY_SHOW_KEYS = ['note1', 'note2'];
async function saveFooterForTenant(tenantId, body, { isPlatform = false } = {}) {
  const existing = await TenantDB.findOne({ id: tenantId });
  const existingShow = existing?.footer?.show || {};
  const footer = { show: {} };
  for (const key of FOOTER_TEXT_FIELDS) footer[key] = String(body[key] || '').trim().slice(0, 300);
  for (const key of FOOTER_SHOW_KEYS) {
    // A non-platform caller (the company admin) can't touch a platform-only
    // toggle either way — on or off — so their save can never flip it;
    // whatever the platform last set stays as-is.
    footer.show[key] = (!isPlatform && PLATFORM_ONLY_SHOW_KEYS.includes(key)) ? !!existingShow[key] : !!body.show?.[key];
  }
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
  const q = { tenantId: req.tenant.id, scannerCode: code, active: true };
  if (req.query.exhibitionId) q.exhibitionId = req.query.exhibitionId;
  const item = await ItemDB.findOne(q);
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

// Validates a {categoryKey: [values]} map against the tenant's own
// variantCategories definitions — unknown categories are dropped, and
// values not in that category's own list are dropped too (silently, for
// the UI tick-path where this can't happen anyway; Excel import does its
// own stricter checking with warnings, see importItemsFromExcel).
function resolveVariantSelections(tenant, rawSelections) {
  if (!tenant.enableVariants || !rawSelections || typeof rawSelections !== 'object') return {};
  const out = {};
  (tenant.variantCategories || []).forEach(cat => {
    const raw = rawSelections[cat.key];
    if (!Array.isArray(raw)) return;
    const valueSet = new Set(cat.values);
    const picked = raw.filter(v => valueSet.has(v));
    if (picked.length) out[cat.key] = picked;
  });
  return out;
}
// Tags are required, same as the fixed Barcode/Item Name fields — every
// category the company has defined needs at least one value ticked.
function validateVariantSelectionsComplete(tenant, resolved) {
  if (!tenant.enableVariants) return null;
  const missing = (tenant.variantCategories || []).filter(cat => !(resolved[cat.key] || []).length);
  if (missing.length) return `Select at least one ${missing.map(c => c.label).join(', ')}`;
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
  // Scoped to exhibition, not just tenant — two different exhibitions'
  // catalogs are independent, so the same code can exist in each. Items
  // with no exhibition yet (exhibitionId === '') all share one bucket,
  // which is exactly today's tenant-wide behavior — nothing changes until
  // items actually start getting assigned to real exhibitions.
  if (scannerCode && await ItemDB.findOne({ tenantId: req.tenant.id, exhibitionId: exhibitionId || '', scannerCode, active: true }))
    return res.status(400).json({ error: `An item with scanner code "${scannerCode}" already exists${exhibitionId ? ' in this exhibition' : ''}` });
  const imageCode = String(fields.imageCode || '').trim();
  // Variant selections only apply if this company has the feature turned
  // on — silently ignored otherwise, so a jewelry company's item payload
  // (which will never include these) behaves identically to before.
  const variantSelections = resolveVariantSelections(req.tenant, req.body.variantSelections);
  const variantErr = validateVariantSelectionsComplete(req.tenant, variantSelections);
  if (variantErr) return res.status(400).json({ error: variantErr });
  const item = {
    id: uuid(), tenantId: req.tenant.id, exhibitionId: exhibitionId || '',
    scannerCode, fields, images: imageCode ? await getImagesForCode(req.tenant.id, imageCode) : [],
    variantSelections,
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
  if (req.tenant.enableVariants && req.body.variantSelections) {
    const resolved = resolveVariantSelections(req.tenant, req.body.variantSelections);
    const variantErr = validateVariantSelectionsComplete(req.tenant, resolved);
    if (variantErr) return res.status(400).json({ error: variantErr });
    updates.variantSelections = resolved;
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
  const q = { tenantId: req.tenant.id };
  if (req.body.exhibitionId) q.exhibitionId = req.body.exhibitionId;
  const existing = await ItemDB.find(q);
  await ItemDB.remove(q);
  logAudit(req, 'item.delete_all', 'item', existing.length, { count: existing.length, exhibitionId: req.body.exhibitionId || null });
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
  const base = originalname.slice(0, originalname.length - ext.length).trim();
  // Forgiving of common real-world naming variations — a space, underscore,
  // or hyphen before the slot digit, optional zero-padding ("_1" or "_01"),
  // and stray trailing whitespace before the extension (all previously
  // caused a "_1"/"_2" file to be treated as an entirely unmatched code
  // instead of being recognized as an extra photo for the base code).
  const m = base.match(/^(.*)[\s_-]0*([12])$/);
  const code = (m ? m[1] : base).trim();
  return { code, slot: m ? Number(m[2]) : 0, ext };
}

app.post('/api/items/bulk-images', resolveTenant, auth, requireRole('admin', 'staff'), (req, res) => {
  bulkImageUploader.array('images', 300)(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those images is too large (max 10MB each)' : err.message });
    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

    const items = await ItemDB.find({ tenantId: req.tenant.id, active: true });
    const codesInUse = new Set(items.map(it => String(it.fields?.imageCode || '').trim().toLowerCase()).filter(Boolean));
    // Maps the lowercased code back to the item's actual, correctly-cased
    // imageCode — so a file typed as "2167k_1.jpg" still gets grouped and
    // saved under the item's real code "2167K", not a separate mismatched
    // one, regardless of what case the uploader happened to type.
    const canonicalCode = {};
    items.forEach(it => {
      const raw = String(it.fields?.imageCode || '').trim();
      if (raw) canonicalCode[raw.toLowerCase()] = raw;
    });

    const groups = {};
    req.files.forEach(file => {
      const { code, slot, ext } = parseImageFilename(file.originalname);
      const key = canonicalCode[code.toLowerCase()] || code; // normalize to the item's real casing when known
      (groups[key] ??= []).push({ file, slot, ext });
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
    // One column per variant category (Color, Size, whatever's defined) —
    // comma-separated, required just like the fixed fields are, so bulk
    // imports can't silently skip past them the way they were before.
    const categoryHeaders = req.tenant.enableVariants ? (req.tenant.variantCategories || []).map(c => `${c.label} (comma-separated: ${c.values.join(', ')}) *`) : [];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[...headers, ...categoryHeaders]]);
    ws['!cols'] = [...headers, ...categoryHeaders].map(() => ({ wch: 22 }));
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
    const categories = req.tenant.enableVariants ? (req.tenant.variantCategories || []) : [];
    const categoryHeaders = categories.map(c => `${c.label} (comma-separated: ${c.values.join(', ')}) *`);
    const q = { tenantId: req.tenant.id, active: true };
    if (req.query.exhibitionId) q.exhibitionId = req.query.exhibitionId;
    const items = await ItemDB.find(q);
    const rows = items.map(it => [
      ...fieldDefs.map(f => it.fields?.[f.key] ?? ''),
      ...categories.map(c => (it.variantSelections?.[c.key] || []).join(', ')),
    ]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[...headers, ...categoryHeaders], ...rows]);
    ws['!cols'] = [...headers, ...categoryHeaders].map(() => ({ wch: 22 }));
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
      // A whole file imports into one exhibition at a time — there's no
      // natural per-row place to specify it in a spreadsheet. Defaults to
      // the same blank bucket every item already uses if not provided.
      const exhibitionId = req.body.exhibitionId || req.query.exhibitionId || '';

      const fieldDefs = await FieldDefDB.find({ tenantId: req.tenant.id, active: true });
      const labelToKey = {};
      fieldDefs.forEach(f => { labelToKey[f.label.trim().toLowerCase()] = f.key; });
      const scannerField = fieldDefs.find(f => f.isScannerKey);
      // Tag columns use the same "(...)" -stripping header match as regular
      // fields — the parenthetical just documents the valid values inline
      // in the sheet, it doesn't need special parsing.
      const categories = req.tenant.enableVariants ? (req.tenant.variantCategories || []) : [];
      const labelToCategory = {};
      categories.forEach(c => { labelToCategory[c.label.trim().toLowerCase()] = c; });

      let created = 0, updated = 0, skipped = 0, tagWarnings = [];
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

        // Match each tag column's comma-separated text against that
        // category's own value list — case/whitespace-insensitive, same
        // reasoning as everywhere else typed input meets a fixed list.
        // Unrecognized values are dropped (not silently accepted as new
        // values) and reported; a category left with nothing matched
        // fails the same "required" check the chip UI enforces.
        const variantSelections = {};
        let rowHasUnmatched = false;
        Object.keys(row).forEach(header => {
          const cat = labelToCategory[baseLabelFromHeader(header)];
          if (!cat || row[header] === '') return;
          const typed = String(row[header]).split(',').map(v => v.trim()).filter(Boolean);
          const canonicalByLower = {}; cat.values.forEach(v => { canonicalByLower[v.toLowerCase()] = v; });
          const matched = [], unmatched = [];
          typed.forEach(v => { const c = canonicalByLower[v.toLowerCase()]; if (c) matched.push(c); else unmatched.push(v); });
          if (matched.length) variantSelections[cat.key] = [...new Set(matched)];
          if (unmatched.length) { rowHasUnmatched = true; tagWarnings.push(`"${scannerCode}": ${cat.label} value(s) not recognized — ${unmatched.join(', ')}`); }
        });
        const existing = await ItemDB.findOne({ tenantId: req.tenant.id, exhibitionId, scannerCode, active: true });
        // Validated against the MERGED result, not just this row's own tag
        // columns — a row updating only some other field, with the tag
        // columns left blank, shouldn't be rejected as "missing tags" when
        // the existing item already has valid ones that will be preserved.
        const mergedTags = req.tenant.enableVariants
          ? { ...(existing?.variantSelections || {}), ...variantSelections }
          : {};
        const completenessErr = validateVariantSelectionsComplete(req.tenant, mergedTags);
        if (completenessErr) { skipped++; tagWarnings.push(`"${scannerCode}": skipped — ${completenessErr}`); continue; }

        if (existing) {
          await ItemDB.update({ id: existing.id }, { fields: { ...existing.fields, ...fields }, variantSelections: mergedTags });
          updated++;
        } else {
          await ItemDB.create({ id: uuid(), tenantId: req.tenant.id, exhibitionId, scannerCode, fields, variantSelections: mergedTags, images: [], active: true, createdAt: new Date().toISOString() });
          created++;
        }
      }
      res.json({ ok: true, created, updated, skipped, total: rows.length, tagWarnings: tagWarnings.slice(0, 20) });
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

const PARTY_EXCEL_HEADERS = ['Firm Name', 'Contact Person', 'Phone', 'City', 'Email'];
app.get('/api/parties/template/excel', resolveTenant, auth, async (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([PARTY_EXCEL_HEADERS]);
    ws['!cols'] = PARTY_EXCEL_HEADERS.map(() => ({ wch: 20 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Buyers');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Buyers_Template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/parties/import/excel', resolveTenant, auth, requireRole('admin'), (req, res) => {
  bulkUploader.single('file')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10MB)' : err.message });
    if (!req.file) return res.status(400).json({ error: 'File is required' });
    try {
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      fs.unlink(req.file.path, () => {});

      // Case/whitespace-tolerant header matching, same reasoning as the
      // item import — a person's exported/re-typed sheet won't always
      // match the template's exact casing.
      const norm = h => String(h).trim().toLowerCase();
      let created = 0, updated = 0, skipped = 0;
      for (const row of rows) {
        const get = label => { for (const h of Object.keys(row)) if (norm(h) === norm(label)) return String(row[h] ?? '').trim(); return ''; };
        const firmName = get('Firm Name'), phone = get('Phone');
        if (!firmName || !phone) { skipped++; continue; }
        const fields = { firmName, contactPerson: get('Contact Person'), phone, city: get('City'), email: get('Email') };
        const existing = await PartyDB.findOne({ tenantId: req.tenant.id, phone });
        if (existing) { await PartyDB.update({ id: existing.id }, fields); updated++; }
        else { await PartyDB.create({ id: uuid(), tenantId: req.tenant.id, ...fields, cardImageUrl: '', source: 'manual', createdAt: new Date().toISOString() }); created++; }
      }
      logAudit(req, 'party.bulk_import', 'party', `${created}+${updated}`, { created, updated, skipped });
      res.json({ ok: true, created, updated, skipped });
    } catch (err) { res.status(500).json({ error: 'Could not read that file — make sure it\'s a valid Excel file (.xlsx)' }); }
  });
});
app.post('/api/parties/bulk-delete', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
  if (!ids.length) return res.status(400).json({ error: 'No buyers selected' });
  if (ids.length > 500) return res.status(400).json({ error: 'Too many at once — delete in smaller batches (max 500)' });
  for (const id of ids) await PartyDB.remove({ id, tenantId: req.tenant.id });
  logAudit(req, 'party.bulk_delete', 'party', ids.length, { count: ids.length, ids });
  res.json({ ok: true, deleted: ids.length });
});
app.post('/api/parties/delete-all', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const existing = await PartyDB.find({ tenantId: req.tenant.id });
  await PartyDB.remove({ tenantId: req.tenant.id });
  logAudit(req, 'party.delete_all', 'party', existing.length, { count: existing.length });
  res.json({ ok: true, deleted: existing.length });
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
    // Only keep tags for categories the tenant actually has, and only
    // values this specific item is actually available in — same
    // "validate against the real list" principle as everywhere else tags
    // are set, not just trusting whatever the client sent.
    let variantTags;
    if (tenant.enableVariants && line.variantTags && typeof line.variantTags === 'object') {
      variantTags = {};
      (tenant.variantCategories || []).forEach(cat => {
        const val = line.variantTags[cat.key];
        if (val && (item.variantSelections?.[cat.key] || []).includes(val)) variantTags[cat.key] = val;
      });
    }
    const hasTags = variantTags && Object.keys(variantTags).length;
    const baseLabel = item.fields?.itemName || item.fields?.productName || item.scannerCode || item.id;
    lineItems.push({
      itemId: item.id, label: hasTags ? `${baseLabel} (${Object.values(variantTags).join(' / ')})` : baseLabel,
      scannerCode: item.scannerCode, images: item.images || [],
      qty, extra, comment: typeof line.comment === 'string' ? line.comment.trim().slice(0, 500) : '',
      ...(hasTags ? { variantTags } : {}),
    });
  }
  const fieldTotals = {};
  orderFields.filter(f => f.showTotal).forEach(f => {
    const raw = lineItems.reduce((sum, l) => sum + (Number(l.extra?.[f.key]) || 0) * l.qty, 0);
    fieldTotals[f.key] = Number(raw.toFixed(f.decimals ?? 2));
  });
  return { lineItems, fieldTotals, orderFields };
}

// Atomically claims the next order number. If the order belongs to an
// exhibition, uses that exhibition participant's own prefix/suffix/start
// config and its own running sequence (client-admin configured, per
// exhibition) — so two exhibitions for the same company can have
// completely independent numbering. Orders with no exhibition (the
// legacy/no-exhibition bucket) keep using the original tenant-wide EX-
// prefixed sequence, unchanged.
async function nextOrderNo(tenant, exhibitionId) {
  if (exhibitionId) {
    const participant = useMongoose
      ? await ExhibitionParticipant.findOne({ tenantId: tenant.id, exhibitionId })
      : db.get('exhibitionParticipants').find({ tenantId: tenant.id, exhibitionId }).value();
    if (participant) {
      const prefix = participant.orderNumberPrefix ?? 'EX';
      const suffix = participant.orderNumberSuffix ?? '';
      const start = participant.orderNumberStart ?? 1000;
      if (useMongoose) {
        let p = participant;
        if (p.orderNumberSeq == null) {
          p = await ExhibitionParticipant.findOneAndUpdate({ id: p.id }, { $set: { orderNumberSeq: start - 1 } }, { new: true });
        }
        const updated = await ExhibitionParticipant.findOneAndUpdate({ id: p.id }, { $inc: { orderNumberSeq: 1 } }, { new: true });
        return `${prefix}${updated.orderNumberSeq}${suffix}`;
      }
      // lowdb — dev-only, single Node process, no real concurrency to race against.
      if (participant.orderNumberSeq == null) {
        db.get('exhibitionParticipants').find({ id: participant.id }).assign({ orderNumberSeq: start - 1 }).write();
      }
      const p2 = db.get('exhibitionParticipants').find({ id: participant.id }).value();
      const next = p2.orderNumberSeq + 1;
      db.get('exhibitionParticipants').find({ id: participant.id }).assign({ orderNumberSeq: next }).write();
      return `${prefix}${next}${suffix}`;
    }
    // Falls through to the tenant-wide sequence below if somehow there's
    // no participant record for this exhibition (shouldn't normally
    // happen — an order can't be placed in an exhibition the tenant isn't
    // actually part of — but better to still number the order than fail).
  }
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
  const orderNo = await nextOrderNo(req.tenant, exhibitionId);

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
  // tenantBaseUrl falls back to the actual request's host, which is always correct.
  const baseUrl = tenantBaseUrl(req, req.tenant);
  // Fire-and-forget — never awaited, so a slow/failing email provider can't
  // delay the response staff are waiting on to hand the buyer their link.
  sendOrderEmails(req.tenant, order, party, baseUrl).catch(err => log.error({ err }, 'sendOrderEmails failed'));
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
  // Same tenantBaseUrl() the create route uses — always resolves to the
  // company's own subdomain regardless of which host (bare domain, www,
  // or the tenant subdomain itself) the browser loaded this list from.
  // Without this, the "View link" button built its href client-side from
  // the current page's host, so an admin browsing on www.expoorders.com
  // got a link missing the company subdomain while staff on the tenant
  // subdomain got it right — same order, two different links.
  const baseUrl = tenantBaseUrl(req, req.tenant);
  res.json(orders.map(o => ({ ...o, shareUrl: `${baseUrl}/order/${o.shareToken}` })));
});

app.get('/api/orders/:id', resolveTenant, auth, async (req, res) => {
  const order = await OrderDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!order || order.deleted) return res.status(404).json({ error: 'Order not found' });
  const baseUrl = tenantBaseUrl(req, req.tenant);
  res.json({ ...order, shareUrl: `${baseUrl}/order/${order.shareToken}` });
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
    return (specs || [])
      .map(spec => {
        if (spec.type === 'orderfield') {
          const val = order.customFields?.[spec.fieldKey];
          return { type: 'orderfield', label: spec.label, value: val ?? '' };
        }
        if (spec.type === 'fieldtotal') {
          // Sums a numeric Item Master field directly across every item —
          // left unresolved here (metadata only), the client does the sum
          // since it already has every item's field values in hand.
          return { type: 'fieldtotal', label: spec.label, fieldKey: spec.fieldKey, unit: spec.unit, decimals: spec.decimals };
        }
        // "total" — fieldKey is a column id, and the value may come from a
        // formula column, which only evaluates client-side (same as every
        // other formula column in the table) — so this is left unresolved
        // here, and the client fills in the actual number once it's
        // computed the same totals it uses for the main table.
        return { type: 'total', label: spec.label, columnId: spec.fieldKey };
      })
      .filter(f => f.type !== 'orderfield' || (f.value !== '' && f.value !== undefined && f.value !== null));
  }
  const viewHeaderFields = resolveFieldList(tenant?.orderViewHeaderFields);
  const viewFooterFields = resolveFieldList(tenant?.orderViewFooterFields);
  // Only send fields the company actually chose to publish — never leak a
  // GST number or phone that was entered but left toggled off.
  const rawFooter = tenant?.footer || { show: {} };
  const footer = {};
  for (const key of FOOTER_TEXT_FIELDS) if (rawFooter.show?.[key] && rawFooter[key]) footer[key] = rawFooter[key];
  if (footer.whatsappNumber && rawFooter.whatsappMessage) footer.whatsappMessage = rawFooter.whatsappMessage;
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
// Lists exhibitions THIS company participates in — not exhibitions it
// owns (companies can no longer create their own; AuroCircle assigns them
// centrally). Each one carries its validTill for this specific company, so
// the frontend can tell which are still open for new orders.
app.get('/api/exhibitions', resolveTenant, auth, async (req, res) => {
  const participants = await ExhibitionParticipantDB.find({ tenantId: req.tenant.id });
  const exhibitions = await ExhibitionDB.find({});
  const byId = {}; exhibitions.forEach(e => { byId[e.id] = e; });
  const today = new Date().toISOString().slice(0, 10);
  const [allItems, allOrders] = await Promise.all([
    ItemDB.find({ tenantId: req.tenant.id, active: true }),
    OrderDB.find({ tenantId: req.tenant.id }),
  ]);
  const itemCountByEx = {}, orderCountByEx = {};
  allItems.forEach(i => { if (i.exhibitionId) itemCountByEx[i.exhibitionId] = (itemCountByEx[i.exhibitionId] || 0) + 1; });
  allOrders.forEach(o => { if (o.exhibitionId) orderCountByEx[o.exhibitionId] = (orderCountByEx[o.exhibitionId] || 0) + 1; });
  const result = participants
    .map(p => {
      const ex = byId[p.exhibitionId];
      if (!ex) return null;
      // "Completed" if either the company closed it themselves, or
      // AuroCircle's paid-for window has passed — either way it stops
      // being offered for new items/orders, but stays fully viewable.
      const expired = !!(p.validTill && p.validTill < today);
      const status = (p.closed || expired) ? 'completed' : 'current';
      return { ...ex, validTill: p.validTill, closed: !!p.closed, status, itemCount: itemCountByEx[ex.id] || 0, orderCount: orderCountByEx[ex.id] || 0,
        orderNumberPrefix: p.orderNumberPrefix ?? 'EX', orderNumberSuffix: p.orderNumberSuffix ?? '', orderNumberStart: p.orderNumberStart ?? 1000, orderNumberInUse: p.orderNumberSeq != null };
    })
    .filter(Boolean);
  res.json(result);
});
// Company admin's own manual close/reopen — independent of validTill,
// private to this company (other companies sharing the same exhibition
// are completely unaffected).
app.put('/api/exhibitions/:id/close', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const p = await ExhibitionParticipantDB.findOne({ exhibitionId: req.params.id, tenantId: req.tenant.id });
  if (!p) return res.status(404).json({ error: 'Not participating in that exhibition' });
  await ExhibitionParticipantDB.update({ id: p.id }, { closed: true });
  res.json({ ok: true });
});
app.put('/api/exhibitions/:id/reopen', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const p = await ExhibitionParticipantDB.findOne({ exhibitionId: req.params.id, tenantId: req.tenant.id });
  if (!p) return res.status(404).json({ error: 'Not participating in that exhibition' });
  await ExhibitionParticipantDB.update({ id: p.id }, { closed: false });
  res.json({ ok: true });
});

// Order numbering — prefix/suffix/starting number, per exhibition, set by
// the company's own admin (not platform admin — each company wants its
// own scheme even within a shared exhibition). Changing the starting
// number only actually resets anything if no order has been placed yet
// under this config (orderNumberSeq still null) — after that, it just
// changes where future numbers pick up from, since silently renumbering
// past orders would break references already sent to buyers.
app.put('/api/exhibitions/:id/order-number-config', resolveTenant, auth, requireRole('admin'), async (req, res) => {
  const p = await ExhibitionParticipantDB.findOne({ exhibitionId: req.params.id, tenantId: req.tenant.id });
  if (!p) return res.status(404).json({ error: 'Not participating in that exhibition' });
  const prefix = String(req.body.prefix ?? 'EX').slice(0, 20);
  const suffix = String(req.body.suffix ?? '').slice(0, 20);
  const start = Number(req.body.start);
  if (!Number.isFinite(start) || start < 1) return res.status(400).json({ error: 'Starting number must be a positive number' });
  const updates = { orderNumberPrefix: prefix, orderNumberSuffix: suffix, orderNumberStart: start };
  // Only actually rewind/advance the live sequence if nothing's been
  // numbered under it yet — otherwise leave orderNumberSeq alone so
  // existing orders' numbers stay meaningful and nothing collides.
  if (p.orderNumberSeq == null) updates.orderNumberSeq = null;
  await ExhibitionParticipantDB.update({ id: p.id }, updates);
  res.json({ ok: true, ...updates });
});

// ── REPORTS ───────────────────────────────────────────────────────────────────
// Computed in application code (not a DB aggregation pipeline) so the same logic
// works identically against MongoDB and the lowdb fallback.
// Shared by the tenant-scoped report routes and the platform-admin
// equivalent below — single-sourced so the numbers can never disagree
// between what a company admin sees and what the platform admin sees.
// Built-in columns always available regardless of what fields a company
// has configured — without these a report can't say which order/buyer/
// item a row is even about. Some only make sense per row type.
const REPORT_META_COLUMNS = {
  item: [
    { key: 'order_no', label: 'Order No' }, { key: 'order_date', label: 'Order Date' }, { key: 'order_status', label: 'Order Status' },
    { key: 'party_name', label: 'Buyer' }, { key: 'party_contact', label: 'Contact Person' }, { key: 'party_phone', label: 'Phone' }, { key: 'party_email', label: 'Email' },
    { key: 'staff_name', label: 'Staff' }, { key: 'item_code', label: 'Item Code' },
    { key: 'item_name', label: 'Item Name' }, { key: 'qty', label: 'Qty' }, { key: 'remark', label: 'Remark' },
  ],
  order: [
    { key: 'order_no', label: 'Order No' }, { key: 'order_date', label: 'Order Date' }, { key: 'order_status', label: 'Order Status' },
    { key: 'party_name', label: 'Buyer' }, { key: 'party_contact', label: 'Contact Person' }, { key: 'party_phone', label: 'Phone' }, { key: 'party_email', label: 'Email' },
    { key: 'staff_name', label: 'Staff' }, { key: 'item_count', label: 'Item Count' }, { key: 'remark', label: 'Remark' },
  ],
};
function validateReportColumns(rawColumns, rowType, fieldDefs, orderCustomFields, variantCategories) {
  const fieldByKey = {}; fieldDefs.forEach(f => { fieldByKey[f.key] = f; });
  const orderFieldByKey = {}; orderCustomFields.forEach(f => { orderFieldByKey[f.key] = f; });
  const variantCatByKey = {}; (variantCategories || []).forEach(c => { variantCatByKey[c.key] = c; });
  const metaKeys = new Set(REPORT_META_COLUMNS[rowType].map(m => m.key));
  const allowedFormulaNames = new Set([
    ...fieldDefs.filter(f => f.type === 'number').map(f => f.key),
    ...orderCustomFields.filter(f => f.type === 'number').map(f => f.key),
    'qty',
  ]);
  const out = [];
  for (const raw of (Array.isArray(rawColumns) ? rawColumns : [])) {
    if (!raw || !['meta', 'itemfield', 'orderfield', 'formula', 'varianttag'].includes(raw.type))
      throw Object.assign(new Error('Each report column needs a valid type'), { status: 400 });
    const col = { id: raw.id || uuid(), type: raw.type };
    if (raw.type === 'meta') {
      if (!metaKeys.has(raw.fieldKey)) throw Object.assign(new Error(`"${raw.fieldKey}" isn't a valid built-in column for this row type`), { status: 400 });
      col.fieldKey = raw.fieldKey;
      col.label = (raw.label || REPORT_META_COLUMNS[rowType].find(m => m.key === raw.fieldKey)?.label || '').trim().slice(0, 60) || raw.fieldKey;
    } else if (raw.type === 'varianttag') {
      // Only makes sense per item line — a single order-level row can span
      // several colors/sizes of the same item, so there's no one value to
      // show (same reasoning that already restricts text Item Master
      // fields to item-level rows).
      if (rowType === 'order') throw Object.assign(new Error('Variant tags can only be used in item-level reports, not order-level'), { status: 400 });
      const cat = variantCatByKey[raw.fieldKey];
      if (!cat) throw Object.assign(new Error(`"${raw.fieldKey}" isn't one of this company's variant tags`), { status: 400 });
      col.fieldKey = raw.fieldKey;
      col.label = (raw.label || cat.label || '').trim().slice(0, 60) || cat.label;
    } else if (raw.type === 'itemfield') {
      const f = fieldByKey[raw.fieldKey];
      if (!f) throw Object.assign(new Error(`"${raw.fieldKey}" isn't an Item Master field`), { status: 400 });
      if (rowType === 'order' && f.type !== 'number') throw Object.assign(new Error(`"${f.label}" is text, not a number — order-level rows can only total numeric Item Master fields`), { status: 400 });
      col.fieldKey = raw.fieldKey; col.unit = f.unit || ''; col.decimals = f.type === 'number' ? (f.decimals ?? 2) : undefined;
      col.label = (raw.label || f.label || '').trim().slice(0, 60) || f.label;
    } else if (raw.type === 'orderfield') {
      const f = orderFieldByKey[raw.fieldKey];
      if (!f) throw Object.assign(new Error(`"${raw.fieldKey}" isn't one of the Order Details fields`), { status: 400 });
      col.fieldKey = raw.fieldKey; col.decimals = f.type === 'number' ? (f.decimals ?? 2) : undefined;
      col.label = (raw.label || f.label || '').trim().slice(0, 60) || f.label;
    } else { // formula
      const formula = String(raw.formula || '').trim();
      if (!formula) throw Object.assign(new Error('Formula column needs a formula'), { status: 400 });
      const check = validateFormula(formula, allowedFormulaNames);
      if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
      col.formula = formula;
      col.label = (raw.label || 'Amount').trim().slice(0, 60) || 'Amount';
    }
    out.push(col);
  }
  return out;
}

// The report row's value for one column, for one item within one order —
// same numeric logic as the order view's getNumericColumnValue, just
// living server-side so both the on-screen report and the Excel export
// compute identically without needing a browser-loaded math library.
function reportItemColumnValue(col, item, order) {
  if (col.type === 'meta') {
    switch (col.fieldKey) {
      case 'order_no': return order.orderNo;
      case 'order_date': return order.createdAt ? new Date(order.createdAt).toLocaleDateString('en-IN') : '';
      case 'order_status': return order.status || '';
      case 'party_name': return order.partyName || '';
      case 'party_contact': return order.partyContactPerson || '';
      case 'party_phone': return order.partyPhone || '';
      case 'party_email': return order.partyEmail || '';
      case 'staff_name': return order.staffName || '';
      case 'item_code': return item.scannerCode || '';
      case 'item_name': return item.label || '';
      case 'qty': return item.qty;
      case 'remark': return item.comment || order.remark || '';
      default: return '';
    }
  }
  if (col.type === 'itemfield') {
    const raw = item.extra?.[col.fieldKey];
    return raw === '' || raw === undefined || raw === null ? '' : raw;
  }
  if (col.type === 'varianttag') return item.variantTags?.[col.fieldKey] || '';
  if (col.type === 'orderfield') return order.customFields?.[col.fieldKey] ?? '';
  if (col.type === 'formula') {
    try {
      const scope = { qty: Number(item.qty) || 0 };
      Object.entries(item.extra || {}).forEach(([k, v]) => { if (v !== '' && v != null && !isNaN(Number(v))) scope[k] = Number(v); });
      Object.entries(order.customFields || {}).forEach(([k, v]) => { if (!(k in scope) && v !== '' && v != null && !isNaN(Number(v))) scope[k] = Number(v); });
      const result = math.evaluate(preprocessPercent(col.formula), scope);
      return typeof result === 'number' ? result : '';
    } catch (e) { return ''; }
  }
  return '';
}
// Computes every row for a report definition, scoped to one exhibition.
// 'item' rowType: one row per order line. 'order' rowType: one row per
// order, with numeric itemfield/formula columns summed across that
// order's lines — same "compute per piece, then add the results together"
// principle used for merged-row formulas and column totals elsewhere,
// applied here at the whole-order level instead of a merged-item level.
async function computeReport(tenant, reportDef, exhibitionId) {
  const q = { tenantId: tenant.id };
  if (exhibitionId) q.exhibitionId = exhibitionId;
  const orders = (await OrderDB.find(q)).filter(o => !o.deleted);
  const rows = [];
  if (reportDef.rowType === 'item') {
    for (const order of orders) {
      for (const item of order.items || []) {
        const row = {};
        reportDef.columns.forEach(col => { row[col.id] = reportItemColumnValue(col, item, order); });
        rows.push(row);
      }
    }
  } else {
    for (const order of orders) {
      const row = {};
      reportDef.columns.forEach(col => {
        if (col.type === 'meta') {
          row[col.id] = col.fieldKey === 'item_count' ? (order.items || []).length : reportItemColumnValue(col, {}, order);
        } else if (col.type === 'orderfield') {
          row[col.id] = order.customFields?.[col.fieldKey] ?? '';
        } else {
          // itemfield (numeric-only, enforced at save time) or formula — sum across every line in the order
          let sum = 0, any = false;
          (order.items || []).forEach(item => {
            const v = reportItemColumnValue(col, item, order);
            if (typeof v === 'number') { sum += v; any = true; }
          });
          row[col.id] = any ? sum : '';
        }
      });
      rows.push(row);
    }
  }
  return rows;
}

async function getReportsForTenant(tenantId, exhibitionId) {
  const q = { tenantId };
  if (exhibitionId) q.exhibitionId = exhibitionId;
  const orders = (await OrderDB.find(q)).filter(o => !o.deleted);
  const byParty = {}, byItem = {}, byStaff = {};
  for (const o of orders) {
    byParty[o.partyId] ??= { partyId: o.partyId, partyName: o.partyName, partyPhone: o.partyPhone, orderCount: 0 };
    byParty[o.partyId].orderCount += 1;
    byStaff[o.staffId] ??= { staffId: o.staffId, staffName: o.staffName, orderCount: 0 };
    byStaff[o.staffId].orderCount += 1;
    for (const line of o.items || []) {
      byItem[line.itemId] ??= { itemId: line.itemId, label: line.label, scannerCode: line.scannerCode, images: line.images || [], qty: 0 };
      byItem[line.itemId].qty += line.qty;
    }
  }
  return {
    byParty: Object.values(byParty).sort((a, b) => b.orderCount - a.orderCount),
    byItem: Object.values(byItem).sort((a, b) => b.qty - a.qty),
    byStaff: Object.values(byStaff).sort((a, b) => b.orderCount - a.orderCount),
  };
}
// Best sellers for the Dashboard — same underlying aggregation as the
// Reports tab's item-wise table, just capped to the top N and exposed on
// its own lightweight endpoint so Dashboard doesn't have to pull every
// party/staff aggregate it doesn't need.
app.get('/api/dashboard/best-sellers', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 50);
  const { byItem } = await getReportsForTenant(req.tenant.id, req.query.exhibitionId);
  res.json(byItem.slice(0, limit));
});

// ── Custom reports (client-facing) ────────────────────────────────────────
app.get('/api/reports/custom', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const reports = await ReportDefDB.find({ tenantId: req.tenant.id });
  res.json(reports.map(r => ({ id: r.id, name: r.name, rowType: r.rowType })));
});
app.get('/api/reports/custom/:id', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const report = await ReportDefDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const rows = await computeReport(req.tenant, report, req.query.exhibitionId);
  res.json({ name: report.name, rowType: report.rowType, columns: report.columns.map(c => ({ id: c.id, label: c.label, unit: c.unit, decimals: c.decimals })), rows });
});
app.get('/api/reports/custom/:id/export', resolveTenant, auth, requireRole('admin', 'staff'), async (req, res) => {
  const report = await ReportDefDB.findOne({ id: req.params.id, tenantId: req.tenant.id });
  if (!report) return res.status(404).json({ error: 'Report not found' });
  try {
    const rows = await computeReport(req.tenant, report, req.query.exhibitionId);
    const headers = report.columns.map(c => c.label);
    const dataRows = rows.map(row => report.columns.map(c => {
      const v = row[c.id];
      if (typeof v === 'number' && c.decimals != null) return Number(v.toFixed(c.decimals));
      return v ?? '';
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    ws['!cols'] = headers.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, report.name.slice(0, 31) || 'Report');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${report.name.replace(/[^\w\- ]/g, '')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
// A request to "/" on a company subdomain (meridian.expoorders.com) should
// go straight to that company's login, not the generic marketing page —
// the marketing page is only for the bare/www domain, where there's no
// specific company to log into yet.
app.get('/', (req, res) => {
  if (detectSubdomainSlug(req)) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
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

// Items and orders created before exhibitions became mandatory don't have
// an exhibitionId at all — this buckets all of them into a single
// "General" exhibition per tenant (creating it if it doesn't exist yet) so
// nothing disappears or breaks once exhibitionId becomes required going
// forward. Runs once at boot; harmless to re-run since it only touches
// records that still have no exhibitionId.
async function migrateExhibitionAssignment() {
  const tenants = await TenantDB.find({});
  for (const tenant of tenants) {
    const orphanItems = (await ItemDB.find({ tenantId: tenant.id })).filter(i => !i.exhibitionId);
    const orphanOrders = (await OrderDB.find({ tenantId: tenant.id })).filter(o => !o.exhibitionId);
    if (!orphanItems.length && !orphanOrders.length) continue;
    // Does this tenant already have its own private "General" exhibition
    // from an earlier run of this migration? Found via their own
    // participation records — exhibitions aren't tenant-owned anymore, but
    // each tenant still gets a PRIVATE one here (not shared with anyone
    // else) purely to preserve their pre-existing data's isolation.
    const myParticipants = await ExhibitionParticipantDB.find({ tenantId: tenant.id });
    const myExhibitions = (await Promise.all(myParticipants.map(p => ExhibitionDB.findOne({ id: p.exhibitionId })))).filter(Boolean);
    let general = myExhibitions.find(e => e.name === 'General');
    if (!general) {
      general = { id: uuid(), name: 'General', location: '', startDate: '', endDate: '', active: true, createdAt: new Date().toISOString() };
      await ExhibitionDB.create(general);
      await ExhibitionParticipantDB.create({ id: uuid(), exhibitionId: general.id, tenantId: tenant.id, validTill: '', addedAt: new Date().toISOString() });
    }
    for (const item of orphanItems) await ItemDB.update({ id: item.id }, { exhibitionId: general.id });
    for (const order of orphanOrders) await OrderDB.update({ id: order.id }, { exhibitionId: general.id });
    log.info({ tenant: tenant.slug, items: orphanItems.length, orders: orphanOrders.length }, 'Migrated orphaned items/orders into General exhibition');
  }
}

connectDB().then(async () => {
  initR2();
  await ensurePlatformAdminFromEnv();
  await migrateFixedFields();
  await migrateSettingsPermissionsDefault();
  await migrateExhibitionAssignment();
  app.listen(PORT, () => log.info({ port: PORT, version: APP_VERSION, builtAt: BUILD_TIME }, 'Expo Orders running'));
}).catch(err => {
  log.fatal({ err }, 'Failed to connect to database');
  process.exit(1);
});
