# Implementation Plan: Programmable Custom Fields & Attendee Management

## Overview
Transform the application into a versatile, reusable badge-and-verification system for any use case (events, conferences, inventory/asset tracking, training sessions, or school attendance) by adding a **dedicated Settings manager for programmable custom fields**. Administrators and supervisors can define global field names and input types (text or preset dropdown choices), which automatically propagate to manual forms, dynamic CSV import/export templates, directory views, and QR scan verification modals.

---

## 1. Key Features & Workflows

### A. Dedicated "Custom Fields" Settings Management
- **Central Management View**: Available in the top navigation or Settings panel for Supervisors and Admins.
- **Programmable Field Properties**:
  - **Field Label / Name** (e.g., `Ticket Category`, `Company`, `Seat Number`, `Asset Location`, `Dietary Preference`).
  - **Input Style**: Free text or preset choices (comma-separated list converted to dropdown selections).
  - **Status & Ordering**: Reorder fields, mark as required/optional, or remove unneeded fields.
- **Instant Template Generator**: A "Download Sample CSV Template" button that dynamically creates a CSV file containing `name`, `identifier`, and all currently defined custom field names as column headers.

### B. Dynamic Add & Edit Person Modals
- **Add Attendee Form**: Automatically renders input fields for all active programmable fields:
  - Dropdown `<select>` for fields configured with preset options.
  - Text `<input>` for freeform fields.
  - Optional "+ Add Ad-hoc Field" button for one-off attendee attributes.
- **Edit Attendee in Directory**:
  - An "Edit" button on each attendee row in the Attendee Directory.
  - Opens the Edit Modal pre-filled with the attendee's Name, Badge Identifier, and current custom field values.
  - Immediate database update via `PUT /api/persons/:id`.

### C. QR Scan Verification Modal
- Scanned badge verification dynamically displays all configured field names and their assigned values.
- Clean layout with highlighted badges/tags for preset categories (e.g., VIP, Speaker, Staff) and clear label-value pairings.

### D. Smart CSV Import & Export
- Bulk CSV import automatically detects column headers matching defined custom fields.
- Directory CSV export includes all active custom fields as dedicated columns.

---

## 2. Technical Architecture & Data Model

### Database Migration (`migrations/0007_custom_field_definitions.sql`)
- Create table `custom_field_definitions`:
  - `id TEXT PRIMARY KEY` (UUID or slug)
  - `name TEXT NOT NULL UNIQUE`
  - `type TEXT NOT NULL DEFAULT 'text'` (`text` or `select`)
  - `options TEXT DEFAULT '[]'` (JSON array of string choices)
  - `is_required INTEGER DEFAULT 0`
  - `sort_order INTEGER DEFAULT 0`
  - `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`

### Backend Endpoints (`src/worker.js` & `server.js`)
- `GET /api/custom-fields` — Retrieve all active field definitions.
- `POST /api/custom-fields` — Create a new field definition (Supervisor/Admin session required).
- `PUT /api/custom-fields/:id` — Update field name, type, or options.
- `DELETE /api/custom-fields/:id` — Remove a field definition.
- `PUT /api/persons/:id` — Update attendee name, identifier, and custom field values.
- `GET /api/persons/template-csv` — Generate on-the-fly CSV sample with active field headers.

### Frontend (`public/index.html`, `public/app.js`, `public/style.css`)
- **Settings View / Tab**: Section for managing custom fields with an interactive "+ New Field" modal and field list table.
- **Dynamic Form Builder**: Form renderer in `modal-add-person` and `modal-edit-person` that dynamically constructs controls based on the loaded field definitions.
- **Directory Table**: Columns automatically display custom field data; "Edit" button opens attendee editor.
- **Scan Confirmation Modal**: Dynamic rendering of all stored fields for the scanned badge.

---

## 3. Automated Testing & Verification
- **Automated Tests (`test/attendance.test.js`)**:
  - Test custom field CRUD endpoints (`GET`, `POST`, `PUT`, `DELETE /api/custom-fields`).
  - Test attendee creation and update (`PUT /api/persons/:id`) with custom field values.
  - Test CSV bulk import with custom field headers.
  - Test scan verification (`/api/scan`) returning custom fields in the verification payload.
- **End-to-End Verification**:
  - Define custom fields in Settings: e.g., "Ticket Tier" (choices: `VIP, General, Speaker`) and "Company" (text).
  - Add attendee using the dynamically generated form and select "VIP".
  - Edit attendee to update their company and ticket tier.
  - Scan the attendee's QR badge and confirm both "Ticket Tier: VIP" and "Company" appear with correct styling.
  - Download sample CSV, verify headers match configured fields, and test import.
