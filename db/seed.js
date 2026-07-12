// Resets db/db.json and loads a demo company so you can log in immediately.
// Run with: npm run seed  (only affects the local lowdb file — has no effect if MONGO_URI is set)
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

const now = () => new Date().toISOString();
// No built-in currency/price concept — a tenant that wants to show amounts on
// the order form just adds a Number field with a unit ("Rs.") like any other,
// configured in Settings > Order Form (demoed below with the seeded Price field).
const tenant = {
  id: uuid(), name: 'Kaashvi Jewels', slug: 'kaashvi', plan: 'free', createdAt: now(),
  orderFields: [{ key: 'price', label: 'Price', unit: 'Rs.', showTotal: true }],
  orderShowImages: true,
  orderSeq: 1001, // one demo order (EX1001) already exists below — next created order will be EX1002
};

// Every company starts with just these 2 built-in fields (see FIXED_FIELDS in
// server.js); the rest here are examples of fields an admin has added on top.
const FIXED_FIELDS = [
  { key: 'itemCode',  label: 'Item Code',  type: 'text', isScannerKey: true, fixed: true },
  { key: 'imageCode', label: 'Image Code', type: 'text', isScannerKey: false, fixed: true },
];
const CUSTOM_FIELDS = [
  { key: 'productName', label: 'Product Name', type: 'text' },
  { key: 'category',    label: 'Category',     type: 'text' },
  { key: 'price',       label: 'Price',        type: 'number', decimals: 2, unit: 'Rs.' },
  { key: 'minQty',      label: 'Min Qty',      type: 'number' },
  { key: 'unit',        label: 'Unit',         type: 'text' },
  { key: 'color',       label: 'Color',        type: 'text' },
  { key: 'material',    label: 'Material',     type: 'text' },
];
const fielddefs = [...FIXED_FIELDS, ...CUSTOM_FIELDS].map((f, i) => ({ id: uuid(), tenantId: tenant.id, order: i, active: true, options: [], fixed: false, decimals: 2, unit: '', createdAt: now(), ...f }));

const admin = { id: uuid(), tenantId: tenant.id, role: 'admin', loginId: 'admin@kaashvi.test', password: bcrypt.hashSync('admin123', 10), name: 'Sanjay Jain', phone: '+919029006090', email: 'admin@kaashvi.test', active: true, createdAt: now() };
const staff = { id: uuid(), tenantId: tenant.id, role: 'staff', loginId: 'staff@kaashvi.test', password: bcrypt.hashSync('staff123', 10), name: 'Priya Mehta', phone: '+919876500011', email: 'staff@kaashvi.test', active: true, createdAt: now() };

// Two items deliberately share Image Code "DZ2" to demo the shared-photo
// behavior (upload one photo named DZ2.jpg and both items show it).
const items = [
  { id: uuid(), tenantId: tenant.id, exhibitionId: '', scannerCode: 'DZ1', fields: { itemCode: 'DZ1', imageCode: 'DZ1', productName: 'Gold Necklace', category: 'Necklace', price: 15000, minQty: 1, unit: 'pcs', color: 'Gold', material: '22K Gold' }, images: [], active: true, createdAt: now() },
  { id: uuid(), tenantId: tenant.id, exhibitionId: '', scannerCode: 'DZ2', fields: { itemCode: 'DZ2', imageCode: 'DZ2', productName: 'Diamond Ring', category: 'Ring', price: 42000, minQty: 1, unit: 'pcs', color: 'Silver', material: 'Platinum' }, images: [], active: true, createdAt: now() },
  { id: uuid(), tenantId: tenant.id, exhibitionId: '', scannerCode: 'DZ2B', fields: { itemCode: 'DZ2B', imageCode: 'DZ2', productName: 'Diamond Ring (matching band)', category: 'Ring', price: 39000, minQty: 1, unit: 'pcs', color: 'Silver', material: 'Platinum' }, images: [], active: true, createdAt: now() },
  { id: uuid(), tenantId: tenant.id, exhibitionId: '', scannerCode: 'DZ3', fields: { itemCode: 'DZ3', imageCode: 'DZ3', productName: 'Pearl Earrings', category: 'Earrings', price: 6500, minQty: 2, unit: 'pair', color: 'White', material: 'Pearl' }, images: [], active: true, createdAt: now() },
];

const party = { id: uuid(), tenantId: tenant.id, firmName: 'Rahul Textiles', contactPerson: 'Rahul Sharma', phone: '+919876543210', email: '', cardImageUrl: '', source: 'manual', createdAt: now() };

const order = {
  id: uuid(), orderNo: 'EX1001', tenantId: tenant.id, exhibitionId: '',
  partyId: party.id, partyName: party.firmName, partyPhone: party.phone,
  staffId: staff.id, staffName: staff.name,
  items: [{ itemId: items[0].id, label: 'Gold Necklace', scannerCode: 'DZ1', images: [], qty: 2, extra: { price: 15000 }, comment: '' }],
  orderFieldsSnapshot: tenant.orderFields, fieldTotals: { price: 30000 }, showImages: true,
  remark: '', status: 'pending', shareToken: uuid(), createdAt: now(),
};

db.setState({
  tenants: [tenant], users: [admin, staff], fielddefs, items, parties: [party], orders: [order], exhibitions: [],
  auditlogs: [], imagesets: [], platformadmins: [],
}).write();

console.log('✅ Seeded demo company "Kaashvi Jewels" (slug: kaashvi)');
console.log('   Admin login: admin@kaashvi.test / admin123');
console.log('   Staff login: staff@kaashvi.test / staff123');
console.log(`   Order link:  http://localhost:${process.env.PORT || 3000}/order/${order.shareToken}`);
console.log('   Note: DZ2 and DZ2B share an Image Code — upload one photo named DZ2.jpg via Item Master > Photos and both items will show it.');
console.log('   No platform admin yet — run: node db/seed-platform-admin.js you@yourcompany.com "a strong password"');
