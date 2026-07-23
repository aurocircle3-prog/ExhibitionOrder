# Expo Orders

Multi-tenant exhibition / store ordering platform — every company gets its own
item master with configurable fields, a scan-to-cart order-taking panel for
staff, visiting-card capture, and shareable order links for buyers.

Built with the same stack/pattern as the ecatlog app in this repo: Express
monolith, MongoDB via Mongoose (local `lowdb` JSON fallback for dev), images on
Cloudflare R2 (local disk fallback), deployed on Render.

## Quick start

```
npm install
npm run seed      # loads a demo company into db/db.json
npm start
```

Open http://localhost:3000 and sign in at `/login.html`:

| Role  | Login ID            | Password  |
|-------|----------------------|-----------|
| Admin | `admin@meridian.test` | `admin123`|
| Staff | `staff@meridian.test` | `staff123`|

Company link (tenant slug): `meridian`. Locally there's no real subdomain, so
the login/register pages ask for the company link explicitly and cache it in
`localStorage`; every API call is sent with an `X-Tenant-Slug` header. In
production, point `*.orders.is` (or your own domain) at this service and the
subdomain is resolved automatically — no header needed.

## How the pieces fit together

- **Tenant = company.** `Tenant.slug` is the subdomain (`meridian.orders.is`),
  chosen at signup (`/register.html`) and validated the same way ecatlog
  validates `storeSlug` — format + reserved-word + uniqueness checks.
- **Roles**: `admin` (one per company, created at signup), `staff` (created
  internally by the admin — no self-signup), `client` (buyers, self-signup at
  `/register-client.html`, tenant-scoped).
- **Item Master** is dynamic: `FieldDef` documents define the columns (label,
  type, order) per tenant, editable from `/admin/item-master.html`. Every
  company starts with just 2 built-in fields — the admin adds whatever else
  they track:
  - **Item Code** — always the scan/barcode value, denormalized onto
    `Item.scannerCode` for fast lookup. Can't be deleted.
  - **Image Code** — drives photo file naming. An item can have up to 3
    photos, uploaded through the UI but stored/served as `{code}`, `{code}_1`,
    `{code}_2` (same convention ecatlog uses for `Image Name`). Can't be
    deleted.
- **Order-taking panel** (`/staff/order.html`): search/create a buyer
  (optionally captured from a visiting-card photo, OCR-assisted if
  `OCR_API_KEY` is set — otherwise typed manually), scan items into a cart
  (keyboard-wedge Bluetooth scanners work out of the box since the code just
  types into the input field; a camera-based fallback uses the browser's
  native `BarcodeDetector` API where available), then submit to generate a
  shareable order link (`/order/:token`) with no login required to view.
- **Reports** (`/admin/reports.html`): party-wise, item-wise and staff-wise
  order totals, computed in application code so the logic is identical
  whether running on MongoDB or the local JSON fallback.

## Environment variables

See `.env.example`. Nothing is required for local dev — leave `MONGO_URI` and
the `R2_*` vars blank to use the JSON file + local disk storage fallback.

## Deploying

- **Render**: `render.yaml` defines a single Node web service (`npm start`).
  Set `MONGO_URI` (MongoDB Atlas), the `R2_*` vars, and `JWT_SECRET` in the
  Render dashboard.
- **Images**: Cloudflare R2 bucket with a public URL (or custom domain)
  configured as `R2_PUBLIC_URL`.
- **Domain**: point a wildcard DNS record (`*.yourdomain.com`) at the Render
  service so `<company>.yourdomain.com` resolves per tenant.
