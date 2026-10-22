# Mandatory Authentication Gateway & Profile Management Plan

Upgrade QRPass with a full-screen mandatory login gateway that prevents access to the application until valid credentials are provided, maintains sessions across reloads until explicit sign out, displays inline error alerts on failure, and features a user profile dropdown with Switch Account and Sign Out in the header.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following parameters were confirmed by the user and govern the implementation:

- **Confirmed Decision (Authentication Gateway)**: A dedicated full-screen login view is displayed when opening the web app while unauthenticated. Header navigation and application tools (scanner, reports, roster) remain completely hidden until sign-in succeeds.
- **Confirmed Decision (Session Persistence)**: Legitimate sessions stay signed in across browser reloads and app restarts until the user explicitly clicks **Sign Out**.
- **Confirmed Decision (Error Indication)**: Invalid login attempts display a clear inline error banner directly inside the login card, preventing access without disturbing layout stability.
- **Confirmed Decision (Header Profile Dropdown)**: The user badge in the top header is upgraded to an interactive profile dropdown menu containing:
  - User identity summary (Display Name and Role Tag).
  - **Switch Account** option (opens credential modal to switch operator without clearing active event context).
  - **Sign Out** option (invalidates token, stops camera streams, clears local session, and immediately displays the full-screen login gate).

---

## 1. Overview & Core Concept

- **What It Does**: Establishes an authentic enterprise security boundary. Opening the application requires entering authorized supervisor or administrator credentials. Unauthenticated visitors cannot see event rosters, active reports, or the camera scanner. Once authenticated, the operator's identity and role are pinned to the session. Operators can switch accounts during shift handoffs or sign out completely when their work is finished.
- **Target Audience / Persona**: Gate supervisors, event staff, and corporate security operators validating badges at entrances.
- **Key Value**: Guarantees zero unauthenticated access, clear audit attribution, frictionless shift changes, and clean single-click sign-outs.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **Unauthenticated Gateway Flow**:
   - Operator visits the app URL.
   - If no valid session exists, the top navigation, tabs, and main application shell remain completely hidden (`display: none`).
   - A centered, full-screen card appears featuring:
     - The orange geometric star brand mark and `"QRPass"` wordmark.
     - Title: `"Sign In"`
     - Subtitle: `"Enter your supervisor or administrator credentials to begin."`
     - Username and Password input fields.
     - Inline error container (rendered if credentials fail: `"Invalid username or password"`).
     - Primary `"Sign In"` button with active loading state.
   - If invalid credentials are submitted, the error banner appears inline and the password field is cleared and focused. Access is strictly blocked.
   - Upon valid authentication, the gate smoothly transitions into the application workspace.

2. **Authenticated Workspace & Session Persistence**:
   - The user enters the app with full privileges according to their role.
   - Reloading the page or reopening the PWA re-verifies the stored token against `/api/auth/me` without requiring re-entry of passwords.
   - In the top header, the user badge features an avatar icon (`👤`), operator name, role badge, and a caret (`▾`).

3. **User Profile Dropdown Flow**:
   - Clicking the user profile badge toggles a clean dropdown menu:
     - **Profile Header**: Operator display name, username, and role badge (`SUPERVISOR` or `ADMIN`).
     - **Switch Account**: Opens a modal to enter credentials for another account without losing the current event filter.
     - **Sign Out**: Calls `/api/auth/logout`, shuts down camera video hardware tracks, deletes local tokens, and immediately transitions back to the full-screen login gate.
   - Pressing `Escape` or clicking anywhere outside automatically closes the dropdown.

### Visual Identity & Theme
- **Color Discipline**: Strict 60-30-10 palette using deep canvas (`#12243a`), crisp white card containers (`#ffffff`), subtle borders (`#d9e2ec`), and focused warm-orange accent (`#ff662a`).
- **Typography**: Clean display sans paired with tabular numerals (`tabular-nums`) for numeric data.
- **Zero-Pill Restraint**: Unboxed metadata, clean dropdown separators, and standard rectangular buttons with subtle rounded corners (`border-radius: 6px`).
- **Micro-Interactions**: Dropdown menu opens with a smooth 150ms slide-fade (`cubic-bezier(0.16, 1, 0.3, 1)`).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Full-Screen Gateway Container vs. Modal Overlay**:
  - *Chosen Approach*: Full-screen standalone view (`#auth-gate`) that hides `<header>` and `<main>` completely.
  - *Why*: A modal overlay can be dismissed by pressing Escape or clicking a backdrop, which could accidentally leak event data. Completely hiding the application DOM until `currentUser` is confirmed guarantees strict access control.

- **Decision 2: Dropdown Menu vs. Dispersed Header Buttons**:
  - *Chosen Approach*: Single interactive profile trigger housing both Switch Account and Sign Out in an accessible dropdown.
  - *Why*: Preserves horizontal space on mobile phones where multiple header buttons cause awkward wrapping or push the event selector off-screen.

- **Decision 3: Complete Hardware Stream Teardown on Sign Out**:
  - *Chosen Approach*: Call `stopCamera()` upon sign-out, stopping media stream tracks.
  - *Why*: Prevents mobile camera indicator lights from staying active in the background when an operator signs out.

---

## 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                      App Boot Sequence                      │
│                                                             │
│  1. Check localStorage for qrpass_auth_token                │
│     ├── Token present ──> GET /api/auth/me                  │
│     │                      ├── Valid: setUser() & showApp() │
│     │                      └── Invalid: showAuthGate()      │
│     └── No token ───────> showAuthGate()                    │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│     #auth-gate (Full Screen)│ │    Application Workspace    │
│ - <header> hidden           │ │ - <header> & <main> visible │
│ - <main> hidden             │ │ - Role-based tab filtering  │
│ - Mandatory form            │ │ - Profile Dropdown:         │
│ - Inline error alert banner │ │    ├── Switch Account       │
│ - Validates /api/auth/login │ │    └── Sign Out -> Gate     │
└─────────────────────────────┘ └─────────────────────────────┘
```

### Component & DOM Changes

1. **`public/index.html`**:
   - Add `#auth-gate` section directly before `<header>`, containing the full-screen branded login card, form (`#form-gate-login`), and inline error alert (`#gate-login-error`).
   - Update `#user-badge-container` in `<header>` into an accessible interactive dropdown button with `#profile-dropdown-menu`.
   - Update `#modal-login` specifically for the "Switch Account" dialog inside the workspace.

2. **`public/style.css`**:
   - Add layout and typography rules for `#auth-gate`, `.auth-card`, and `.auth-error-banner`.
   - Add styles for `.profile-dropdown`, `.profile-menu`, `.profile-menu-header`, and `.profile-menu-item`.
   - Ensure responsive touch targets ($\ge 44\text{px}$) on mobile devices.

3. **`public/app.js`**:
   - Add `showAuthGate()` and `showApp()`.
   - Wire `#form-gate-login` submit handler: verifies credentials against `/api/auth/login`, sets token, updates state, and calls `showApp()`. On failure, displays the inline error banner.
   - Wire profile dropdown toggle, outside click dismissal, and escape key listener.
   - Wire `Sign Out` button: calls `/api/auth/logout`, terminates active camera streams, clears token, and triggers `showAuthGate()`.
   - Wire `Switch Account` button: opens the switch account dialog.
