# QR Attendance & Roster Verification System

Comprehensive implementation plan to expand the QR badge verifier into a full-featured attendance tracking and roster management platform with camera scanning, modal confirmation, group attendance reports, and bulk roster import.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following decisions were confirmed during the planning interview and govern the system design:

- **Confirmed Decision 1 (Session Organization)**: Multiple named sessions or events (e.g., "General Assembly 2026", "Workshop Day 1", "Morning Roll Call") with an active session selector and historical reporting.
- **Confirmed Decision 2 (Scan Interaction)**: When a QR code is detected, the system immediately queries the database and displays a clean confirmation modal featuring the person's photo/avatar initials, full name, identifier number, group, and current session status, with an explicit **Mark Present** confirmation button (or notification if already checked in).
- **Confirmed Decision 3 (Bulk Import)**: Admin provides both a file upload (drag-and-drop `.csv`) and a direct CSV textarea paste with column auto-mapping (`firstName, lastName, identifierNumber, group`) and a live pre-import validation table.
- **Confirmed Decision 4 (QR Code Decoding)**: Dual compatibility supporting both:
  1. Plain identifier strings/numbers (e.g., `"1024"`, `"EMP-9821"`, numeric barcode/QR data).
  2. The existing 84-hex AES-128 encrypted time-based badge format (decrypted to extract the 32-bit integer identifier).

---

## 1. Overview & Core Concept

- **What It Does**: A web application that scans attendees' QR badges via device camera or paste input, matches the identifier against an enrolled roster in Cloudflare D1 (and local SQLite), prompts the operator with a confirmation popup, and logs attendance per session. It provides live group reports displaying present vs. missing attendees and allows administrators to manage and bulk-import the roster.
- **Target Audience / Persona**: Event coordinators, school/university administrators, corporate receptionists, and session monitors running check-ins on mobile tablets, phones, or laptop webcams.
- **Key Value**: Eliminates manual paper checklists and slow search queries; enables rapid, reliable badge check-in with instant group headcount visibility.

---

## 2. User Experience & Visual Design

### A. Navigation & Top Bar Contract

A unified, responsive top bar adhering to the one-row, three-zone contract:
- **Brand Zone**: `QR Attendance` wordmark with subtle session indicator.
- **Nav Links / Tab Bar**:
  - `Scanner`: Camera viewport, active session badge, paste fallback, and confirmation popup.
  - `Reports`: Real-time group attendance summary, percentage metrics, and present/missing lists.
  - `Roster`: Attendee directory with search, filter by group, single person creation, and bulk CSV import.
  - `Settings / Admin`: Key configuration, session manager, and basic auth administration.
- **Action Zone**: Active session switcher dropdown or quick-action button.

### B. Key User Flows

```
┌────────────────────────────────────────────────────────────────────────┐
│ Scanner View                                                           │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ Active Session: [ Morning Keynote ▼ ]   [Sound: ON]                │ │
│ │                                                                    │ │
│ │ ┌───────────────────────────┐    ┌───────────────────────────────┐ │ │
│ │ │                           │    │ Latest Check-in               │ │ │
│ │ │     Camera Video Stream   │    │ Maria Santos (Engineering)    │ │ │
│ │ │     [jsQR scanner active] │    │ Marked Present · 09:14 AM     │ │ │
│ │ │                           │    │ Session Progress: 42 / 60     │ │ │
│ │ └───────────────────────────┘    └───────────────────────────────┘ │ │
│ │ [ Start Camera ] [ Flip Camera ]                                   │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ Modal Confirmation Dialog (Appears upon scan)                      │ │
│ │ ┌────────────────────────────────────────────────────────────────┐ │ │
│ │ │ [MS] Maria Santos                                              │ │ │
│ │ │ ID: 104829 · Group: Engineering                                │ │ │
│ │ │ Status: Not yet marked for "Morning Keynote"                   │ │ │
│ │ │                                                                │ │ │
│ │ │ [ Cancel / Skip ]            [ Mark Present (Enter) ]          │ │ │
│ │ └────────────────────────────────────────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Scanner Flow**:
   - The operator selects or verifies the active session.
   - The camera detects either a plain ID QR or an encrypted badge QR.
   - The audio context chirps a detection tone and immediately surfaces the **Attendee Modal**.
   - Operator reviews the person's name and group, then clicks **Mark Present** (or presses `Enter` / spaces hotkey).
   - The system records the attendance with timestamp and logs the check-in; an affirmative two-tone beep plays and the modal smoothly closes, returning to ready scan state.
   - If the person was already marked present, the modal indicates "Already Present at [Time]" with an option to keep or update.
   - If an identifier is not in the database, a warning tone sounds with an option to "Quick Enroll" or dismiss.

2. **Reports Flow**:
   - High-level metric tiles: Total Enrolled, Total Present, Total Missing, Overall Attendance %.
   - **Per-Group Breakdown Cards**: Each group (e.g. "Operations", "Sales", "Team Blue") displays its count and progress bar.
   - **Interactive Filter & Drill-down**:
     - Toggle between `All`, `Missing Only`, and `Present Only`.
     - Filter by Group dropdown and quick text search (name or ID).
     - Individual checkmark actions to manually toggle attendance status if an attendee forgets their badge.
     - **Export Report Button**: One-click download of the session attendance CSV.

3. **Roster Management Flow (Admin / Roster Tab)**:
   - **Add Single Person Modal**: Fields for First Name, Last Name, Identifier Number (numeric or alphanumeric), and Group Name (with auto-suggest of existing groups).
   - **Bulk Import Modal**:
     - Drag-and-drop CSV file or paste raw comma/tab delimited text.
     - Sample preview: `First Name, Last Name, Identifier, Group`.
     - Live validation preview highlighting missing columns, duplicates, or format warnings before inserting into D1/SQLite.
     - Batch submit with progress and summary feedback ("54 persons added, 2 updated").
   - Searchable, paginated person list with edit and remove actions.

### C. Visual Identity & Theme

- **Aesthetic Direction**: High-clarity, utilitarian enterprise operations console.
- **Palette**: Deep navy header (`#12243a`) matching the repository's identity, soft slate background (`#f3f6f9`), crisp white cards with hairline borders (`#dbe5ea`), rich emerald green accents (`#126e62` hover `#0b544b`) for affirmative actions, and warm amber for missing/pending alerts.
- **Typography**: Clean sans-serif hierarchy with `tabular-nums` for all identifiers, counts, timestamps, and percentages.
- **Anti-Slop Discipline**: No arbitrary pill badges, no pulsing neon dots, no fake system telemetry. Clean unboxed metadata with `·` separators.

---

## 3. Key Product Decisions & Trade-Offs

- **Database Engine (Cloudflare D1 & SQLite Compatibility)**:
  - *Decision*: Extend the existing D1 schema migrations (`migrations/0003_attendance.sql`) and ensure `server.js` applies them to the local SQLite database seamlessly.
  - *Why*: Maintains 100% compatibility with both Cloudflare Workers D1 deployment and AI Studio local/container execution without external database dependencies.
- **Dual QR Format Resolution**:
  - *Decision*: When raw QR content is captured:
    1. First check if it matches an 84-character hexadecimal string. If so, attempt AES-GCM decryption using the active key to extract the 32-bit integer identifier.
    2. Otherwise, treat the scanned content directly as an identifier string (trimmed plain text / number).
  - *Why*: Allows backwards compatibility with the existing time-badge issuer while fulfilling the new requirement for simple, direct identifier badges.
- **Session-Based Attendance Isolation**:
  - *Decision*: Store attendance in a join table `attendance_records` linked to `session_id` and `person_id`.
  - *Why*: Allows organizations to use the same roster across multiple days or events without overwriting historical data.

---

## 4. Technical Architecture & Data Strategy

### System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Browser Client                                │
│                                                                          │
│  ┌───────────────────────┐ ┌──────────────────────┐ ┌──────────────────┐ │
│  │     Scanner View      │ │     Reports View     │ │   Roster View    │ │
│  │ (jsQR + Camera/Paste) │ │ (Group Progress Bars)│ │  (CRUD + Bulk)   │ │
│  └──────────┬────────────┘ └──────────┬───────────┘ └─────────┬────────┘ │
│             │                         │                       │          │
│             └─────────────────────────┼───────────────────────┘          │
│                                       ▼                                  │
│                             Client API Controller                        │
└───────────────────────────────────────┬──────────────────────────────────┘
                                        │ HTTP JSON API
                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Node Server / Cloudflare Worker                      │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ API Endpoints:                                                     │  │
│  │ • POST /api/scan             • GET  /api/reports                   │  │
│  │ • POST /api/attendance/mark  • GET/POST /api/persons               │  │
│  │ • GET/POST /api/sessions     • POST /api/persons/bulk              │  │
│  └─────────────────────────────────┬──────────────────────────────────┘  │
│                                    ▼                                     │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Data Access Layer (D1 Database / SQLite Interface)                  │  │
│  │                                                                    │  │
│  │  ┌──────────────┐     ┌──────────────┐     ┌─────────────────────┐ │  │
│  │  │   persons    │◀────│ attendance   │────▶│      sessions       │ │  │
│  │  │ (ID, Name,   │     │ (session_id, │     │ (ID, Name, Date,    │ │  │
│  │  │  Group)      │     │  person_id)  │     │  Active Flag)       │ │  │
│  │  └──────────────┘     └──────────────┘     └─────────────────────┘ │  │
│  │  ┌──────────────┐     ┌──────────────┐     ┌─────────────────────┐ │  │
│  │  │  badge_key   │     │ scan_history │     │   request_bucket    │ │  │
│  │  └──────────────┘     └──────────────┘     └─────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Database Schema Expansion (`migrations/0003_attendance.sql`)

```sql
-- Persons roster
CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  identifier_number TEXT NOT NULL UNIQUE,
  group_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persons_identifier ON persons(identifier_number);
CREATE INDEX IF NOT EXISTS idx_persons_group ON persons(group_name);

-- Attendance sessions
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Attendance check-in records
CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  identifier_number TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'present',
  source TEXT NOT NULL CHECK (source IN ('camera', 'paste', 'manual')),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(person_id) REFERENCES persons(id) ON DELETE CASCADE,
  UNIQUE(session_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance_records(session_id);
```

### API Endpoint Specifications

1. `POST /api/scan`:
   - Payload: `{ "raw": string, "sessionId": number, "source": "camera" | "paste" }`
   - Logic: Resolves identifier (decodes encrypted badge if 84 hex, or uses string directly). Queries `persons` by `identifier_number`. Checks if record exists in `attendance_records` for `sessionId`.
   - Returns: `{ "found": boolean, "person": { id, firstName, lastName, identifierNumber, groupName }, "alreadyPresent": boolean, "markedAt": number | null, "rawIdentifier": string }`
2. `POST /api/attendance/mark`:
   - Payload: `{ "sessionId": number, "personId": number, "source": "camera" | "paste" | "manual" }`
   - Logic: Inserts or confirms attendance in `attendance_records`.
   - Returns: `{ "success": true, "record": { id, scannedAt, status } }`
3. `GET /api/reports?sessionId=<id>`:
   - Returns: Overall stats (total, present, missing, percent) and `groups`: `[{ groupName, total, present, missing, percent, members: [...] }]`.
4. `GET /api/persons`:
   - Returns: List of all enrolled persons with search and group filters.
5. `POST /api/persons`:
   - Creates a single person `{ firstName, lastName, identifierNumber, groupName }`.
6. `POST /api/persons/bulk`:
   - Payload: `{ "persons": [{ firstName, lastName, identifierNumber, groupName }] }`
   - Batch inserts or updates existing records; returns summary counts.
7. `GET /api/sessions` & `POST /api/sessions`:
   - Manage event sessions.

---

## 5. Execution Stages

- **Stage 1 (Database Migration & Protocol)**:
  - Add `migrations/0003_attendance.sql`.
  - Update `server.js` and `src/worker.js` to execute the migration and register new API handlers.
- **Stage 2 (Backend API Implementation)**:
  - Implement `/api/scan`, `/api/attendance/mark`, `/api/reports`, `/api/persons`, `/api/persons/bulk`, and `/api/sessions`.
  - Write unit/integration tests in `test/attendance.test.js` verifying dual QR parsing, attendance tracking, and reporting.
- **Stage 3 (Frontend Views & UI Components)**:
  - Refactor `public/index.html` and `public/app.js` into clean, tabbed navigation: **Scanner**, **Reports**, **Roster**, and **Admin**.
  - Build the **Attendance Confirmation Popup** modal with keyboard shortcuts and audio cues.
  - Build the **Group Reports View** with progress bars, filtered tables, and CSV export.
  - Build the **Roster & Bulk Import View** with CSV upload and live preview.
- **Stage 4 (Verification & Polish)**:
  - Run all unit tests with `npm test`.
  - Verify app compilation with `compile_applet` and `lint_applet`.
  - Validate in browser across desktop and mobile viewports.
