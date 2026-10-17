# QRPass — Mobile-First Multi-Supervisor PWA Attendance System

Comprehensive implementation plan to elevate the app into **QRPass**, an installable Progressive Web App (PWA) optimized for mobile smartphones and tablets. It introduces role-based access control (Admin vs. Supervisor accounts), concurrent multi-supervisor scanning with real-time sync, supervisor audit attribution on reports, dedicated camera stop controls, and the new orange star brand identity.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and product decisions were confirmed during the planning phase:

- **Confirmed Decision 1 (Brand & Identity)**: Renamed to **QRPass** featuring the custom orange geometric star brand mark. All internal infrastructure mentions (Cloudflare, D1, SQLite) are removed in favor of clean, professional branding.
- **Confirmed Decision 2 (Role-Based Access & Individual Logins)**:
  - **Admin**: Master login (`admin`) with exclusive permissions to create events/sessions, manage attendees (add, delete, bulk CSV import), create and manage supervisor accounts, and manage security keys.
  - **Supervisor / Operator**: Individual accounts (username and password) that log in directly. Supervisors can select any active event, access the high-performance camera scanner (with start and stop controls), and view group attendance reports.
- **Confirmed Decision 3 (Supervisor Audit Trail)**: When a supervisor marks an attendee present, the record permanently stores `verified_by_id` and `verified_by_name`. Reports and CSV exports explicitly show which supervisor approved/verified each attendee.
- **Confirmed Decision 4 (Concurrent Multi-Supervisor Sync)**: Real-time background sync (polling every 3–4 seconds with optimistic local UI updates) ensures all supervisors stationed across different entry gates or doors see updated headcounts and never duplicate check-ins.
- **Confirmed Decision 5 (PWA & Mobile Installability)**: Full PWA support with Web App Manifest, Service Worker for asset caching, 192px/512px icons, apple-touch-icon, and a non-intrusive In-App Install button with iOS Safari instructions.

---

## 1. Overview & Core Concept

- **What It Does**: QRPass is a mobile-first badge verification and check-in PWA. Supervisors log into their individual accounts on their phones or tablets, select an event, and scan attendee QR codes. The app displays an instant confirmation card, stamps the supervisor's name on the attendance record, updates live headcounts across all active supervisor devices, and generates real-time group reports.
- **Primary Users**: Supervisors, receptionists, event coordinators, and security operators operating mobile phones and tablets at doors, gates, or registration desks.
- **Key Value**: Enables multiple team members to manage check-ins concurrently without collisions, provides transparent supervisor accountability, and runs reliably as an installed home-screen app on iOS and Android.

---

## 2. User Experience & Visual Design

### A. Mobile-First Layout & Touch Ergonomics

- **Mobile Viewport Priority**: Designed for one-handed thumb interaction with $\ge 44\text{px}$ touch targets, sticky bottom navigation or clean top header tabs, and high-contrast status feedback.
- **Scanner View**:
  - Live camera viewport with high-visibility scan reticle.
  - Dedicated **Start Camera** and **Stop Camera** action buttons.
  - Fast camera switcher (front/back camera).
  - Audio toggle for noisy environments.
  - Quick manual search / paste drawer for scratched or unreadable badges.
- **Confirmation Popup (Modal)**:
  - Surfaces immediately upon QR detection without lag.
  - Large attendee name, group badge, and identifier.
  - Prominent **Mark Present** confirmation button styled with high-contrast emerald green (`#126e62`).
  - Stamped with the current supervisor's name ("Verifying as: Supervisor John").
- **Group Reports View**:
  - Top summary cards: Total Enrolled, Present, Missing, % Attendance Rate.
  - Group progress bars showing real-time fill rates.
  - Filterable attendee table showing: Name, Identifier, Group, Status, Time, and **Verified By (Supervisor Name)**.
  - One-click CSV export containing the full supervisor audit trail.
- **Roster & Event Management (Admin Only)**:
  - Gated behind Admin credentials.
  - Add Person form, Bulk CSV upload + paste preview, and Session creation.
  - Supervisor Accounts Manager: create and manage supervisor logins.

### B. Visual Identity & Brand Styling

- **Brand Mark**: Vibrant geometric orange star (`#FF6B35`) paired with clean deep navy typography (`#12243a`).
- **Color Discipline**:
  - 60% Clean slate/white background (`#f3f6f9` canvas, `#ffffff` cards).
  - 30% Structural borders and navy header (`#12243a`).
  - 10% Accent budget: Emerald green (`#126e62`) for verified attendance; warm amber (`#d97706`) for missing alerts; vibrant orange (`#ff6b35`) for brand accents and active indicators.
- **PWA Elements**: Standalone mobile display mode without browser address bars; custom orange star splash screen.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Authentication & Session Token Strategy**:
  - *Chosen Approach*: Lightweight HTTP cookie / token session authentication stored in SQLite `auth_sessions`.
  - *Why*: Eliminates complex third-party auth dependencies; works seamlessly in both standalone PWA mode and mobile Safari/Chrome browsers without popup blocking.
  - *Roles*: `admin` (full permissions) vs. `supervisor` (scanner & reports access only).
- **Decision 2: Supervisor Audit Attribution**:
  - *Chosen Approach*: Add `verified_by_user_id` and `verified_by_name` columns to `attendance_records`.
  - *Why*: Directly satisfies the requirement to show on reports which supervisor verified each user, supporting multi-gate accountability.
- **Decision 3: Multi-Supervisor Concurrency & Polling Sync**:
  - *Chosen Approach*: Lightweight 3-second background polling + instant broadcast after local check-in.
  - *Why*: Works natively across ephemeral containers, edge workers, and mobile browsers without requiring complex persistent WebSocket state servers, while maintaining $<3$s freshness across all devices.
- **Decision 4: PWA Offline Shell Caching**:
  - *Chosen Approach*: Cache-first strategy for static assets (HTML, CSS, JS, jsQR, icons) via Service Worker, with network-first for live scan & report APIs.
  - *Why*: Guarantees instant app boot on mobile home screens even on spotty cellular connections.

---

## 4. Technical Architecture & Data Strategy

### System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                        QRPass Mobile PWA Client                        │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Top Bar: Orange Star Brand · Active Event Dropdown · User Badge  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─────────────────────────┐ ┌──────────────────────┐ ┌──────────────┐ │
│  │      Scanner View       │ │     Reports View     │ │ Admin Roster │ │
│  │ [Start/Stop Camera]     │ │ [Live Group Headcount│ │ [Admin Only: │ │
│  │ [Modal Confirmation]    │ │  + Verified By Column│ │  Roster/Bulk/│ │
│  │                         │ │  + CSV Export]       │ │  Supervisors]│ │
│  └────────────┬────────────┘ └──────────┬───────────┘ └──────┬───────┘ │
│               │                         │                    │         │
│  ┌────────────┴─────────────────────────┴────────────────────┴──────┐  │
│  │ Service Worker (pwa-sw.js) & Manifest (manifest.json)            │  │
│  │ • Offline Asset Precaching  • Install Prompt Flow ('beforeprompt')│  │
│  └──────────────────────────────────────┬───────────────────────────┘  │
└─────────────────────────────────────────┼──────────────────────────────┘
                                          │ HTTPS JSON API
                                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Node Server / Worker                            │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Auth Middleware (Admin vs. Supervisor Session Tokens)            │  │
│  ├──────────────────────────────────────────────────────────────────┤  │
│  │ Endpoints:                                                       │  │
│  │ • POST /api/auth/login        • POST /api/scan                   │  │
│  │ • POST /api/auth/logout       • POST /api/attendance/mark        │  │
│  │ • GET  /api/auth/me           • GET  /api/reports                │  │
│  │ • GET/POST /api/supervisors   • GET/POST /api/persons            │  │
│  │ • GET/POST /api/sessions      • POST /api/persons/bulk           │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Database Storage (SQLite / Cloudflare D1)                        │  │
│  │ • users (id, username, password_hash, display_name, role)        │  │
│  │ • sessions (id, name, is_active, created_at)                     │  │
│  │ • persons (id, first_name, last_name, identifier_number, group)  │  │
│  │ • attendance_records (+ verified_by_id, verified_by_name)        │  │
│  │ • auth_sessions (token, user_id, expires_at)                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

### Database Schema Expansion (`migrations/0004_supervisors_and_pwa.sql`)

```sql
-- Users and Supervisors table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor')),
  created_at INTEGER NOT NULL
);

-- Active user sessions for PWA tokens
CREATE TABLE IF NOT EXISTS user_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Upgrade attendance records with supervisor attribution
ALTER TABLE attendance_records ADD COLUMN verified_by_name TEXT;
ALTER TABLE attendance_records ADD COLUMN verified_by_id INTEGER;

-- Seed default supervisor account if none exists (admin / supervisor1)
INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at)
VALUES (1, 'admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'Administrator', 'admin', 1700000000);

INSERT OR IGNORE INTO users (id, username, password_hash, display_name, role, created_at)
VALUES (2, 'supervisor1', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'Supervisor Alex', 'supervisor', 1700000000);
```

---

## 5. Execution Steps

1. **Brand Assets & Icons**:
   - Generate vector SVG and high-resolution PNG icons (192x192, 512x512, apple-touch-icon) matching the uploaded orange star logo.
   - Configure `manifest.json` with name `QRPass`, short name `QRPass`, theme color `#12243a`, background `#ffffff`, and `display: standalone`.
2. **Database Migration & Auth Service**:
   - Create `migrations/0004_supervisors_and_pwa.sql`.
   - Update `server.js` and `src/worker.js` to execute the migration and seed default admin (`admin` / `admin`) and sample supervisor (`supervisor1` / `admin`).
   - Implement `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, and `/api/supervisors`.
3. **Attendee Verification with Supervisor Attribution**:
   - Update `/api/attendance/mark` and `/api/attendance/toggle` to capture the authenticated supervisor's ID and display name.
   - Update `/api/reports` to output `verifiedByName` and include it in CSV exports.
4. **PWA Service Worker & Install Flow**:
   - Create `public/sw.js` for caching shell assets.
   - Add in-app install prompt banner handling `beforeinstallprompt` with iOS Safari instructions.
5. **Mobile-First UI & Camera Controls**:
   - Add explicit **Stop Camera** button alongside **Start Camera**.
   - Style role-aware navigation: Supervisors see `Scanner` and `Reports`; Admin sees `Scanner`, `Reports`, `Roster`, `Supervisors`, and `Settings`.
   - Clean all footers and headers of Cloudflare, D1, or SQLite technical mentions.
6. **Testing & Verification**:
   - Unit tests covering authentication, supervisor creation, scan attribution, and report generation.
   - Compilation and lint checks via `compile_applet` and `lint_applet`.
