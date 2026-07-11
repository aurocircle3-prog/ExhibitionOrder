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
const tenant = { id: uuid(), name: 'Kaashvi Jewels', slug: 'kaashvi', plan: 'free', currency: '₹', createdAt: now() };

// Every company starts with just these 2 built-in fields (see FIXED_FIELDS in
// server.js); the rest here are examples of fields an admin has added on top.
const FIXED_FIELDS = [
  { key: 'itemCode',  label: 'Item Code',  type: 'text', isScannerKey: true, fixed: true },
  { key: 'imageCode', label: 'Image Code', type: 'text', isScannerKey: false, fixed: true },
];
const CUSTOM_FIELDS = [
  { key: 'productName', label: 'Product Name', type: 'text' },
  { key: 'category',    label: 'Category',     type: 'text' },
  { key: 'price',       label: 'Price',        type: 'number' },
  { key: 'minQty',      label: 'Min Qty',      type: 'number' },
  { key: 'unit',        label: 'Unit',         type: 'text' },
  { key: 'color',       label: 'Color',        type: 'text' },
  { key: 'material',    label: 'Material',     type: 'text' },
];
const fielddefs = [...FIXED_FIELDS, ...CUSTOM_FIELDS].map((f, i) => ({ id: uuid(), tenantId: tenant.id, order: i, active: true, options: [], fixed: false, createdAt: now(), ...f }));

const admin = { id: uuid(), tenantId: tenant.id, role: 'admin', loginId: 'admin@kaashvi.test', password: bcrypt.hashSync('admin123', 10), name: 'Sanjay Jain', phone: '+919029006090', email: 'admin@kaashvi.test', active: true, createdAt: now() };
const staff = { id: uuid(), tenantId: tenant.id, role: 'staff', loginId: 'staff@kaashvi.test', password: bcrypt.hashSync('staff123', 10), name: 'Priya Mehta', phone: '+919876500011', email: 'staff@kaashvi.test', active: true, createdAt: now() };

const items = [
  { id: uuid(), tenantId: tenant.id, exhibitionId: '', scannerCode: 'DZ1', fields: { itemCode: 'DZ1', imageCode: 'DZ1', productName: 'Gold Necklace', category: 'Necklace', price: 15000, minQty: 1, unit: 'pcs', color: 'Gold', material: '22K Gold' }, images: [], active: true, createdAt: now() },
  { id: uuid(), tenantId: tenant.id, exhibitionId: '', scannerCode: 'DZ2', fields: { itemCode: 'DZ2', imageCode: 'DZ2', productName: 'Diamond Ring', category: 'Ring', price: 42000, minQty: 1, unit: 'pcs', color: 'Silver', material: 'Platinum' }, images: [], active: true, createdAt: now() },
  { id: uuid(), tenantId: tenant.id, exhibitionId: '', scannerCode: 'DZ3', fields: { itemCode: 'DZ3', imageCode: 'DZ3', productName: 'Pearl Earrings', category: 'Earrings', price: 6500, minQty: 2, unit: 'pair', color: 'White', material: 'Pearl' }, images: [], active: true, createdAt: now() },
];

const party = { id: uuid(), tenantId: tenant.id, firmName: 'Rahul Textiles', contactPerson: 'Rahul Sharma', phone: '+919876543210', email: '', cardImageUrl: '', source: 'manual', createdAt: now() };

const order = {
  id: uuid(), orderNo: 'EX1001', tenantId: tenant.id, exhibitionId: '',
  partyId: party.id, partyName: party.firmName, partyPhone: party.phone,
  staffId: staff.id, staffName: staff.name,
  items: [{ itemId: items[0].id, label: 'Gold Necklace', scannerCode: 'DZ1', image: '', qty: 2, price: 15000, subtotal: 30000 }],
  total: 30000, remark: '', status: 'pending', shareToken: uuid(), createdAt: now(),
};

db.setState({
  tenants: [tenant], users: [admin, staff], fielddefs, items, parties: [party], orders: [order], exhibitions: [],
}).write();

console.log('✅ Seeded demo company "Kaashvi Jewels" (slug: kaashvi)');
console.log('   Admin login: admin@kaashvi.test / admin123');
console.log('   Staff login: staff@kaashvi.test / staff123');
console.log(`   Order link:  http://localhost:${process.env.PORT || 3000}/order/${order.shareToken}`);
