# Authentication Gateway & Profile Management Implementation Plan

Upgrade QRPass with a mandatory full-screen login gateway that prevents access to the application until valid credentials are provided, paired with a user profile dropdown featuring Switch Account and Sign Out capabilities.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following design choices were confirmed during clarification and will govern the implementation:

- **Confirmed Decision (Authentication Gateway)**: A dedicated full-screen login view is displayed when opening the app while unauthenticated. Header navigation and application tools (scanner, reports, roster) remain completely hidden until sign-in succeeds.
- **Confirmed Decision (Header Profile Dropdown)**: The user badge in the top header is upgraded to an interactive profile dropdown menu containing:
  - Active user identity header (Display Name & Role Badge).
  - **Switch Account** option (allows switching credentials without resetting general event state).
  - **Sign Out** option (invalidates token, stops camera stream, clears local session, and returns directly to the full-screen login screen).
- **Confirmed Decision (Session Persistence)**: Legitimate sessions verified via token are restored seamlessly on page reload; if token is missing or expired, the full-screen login gate appears immediately.

---

## 1. Overview & Core Concept

- **What It Does**: Establishes a true enterprise security boundary for QRPass. Rather than allowing unauthenticated visitors to view the camera scanner or reports in the background, the application presents a focused, brand-aligned login gate. Once authenticated, operators access the tools with clear attribution. Users can switch operators on shared gate tablets or cleanly sign out when their shift concludes.
- **Target Audience / Persona**: Gate supervisors and system administrators using mobile phones, tablets, or desktop stations at event entrances.
- **Key Value**: Security enforcement, prevention of unauthorized check-ins, transparent shift handoffs, and shift sign-outs.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **First-Time / Unauthenticated Access**:
   - Visitor navigates to the app URL.
   - The top header navigation, tabs, and main application shell remain hidden.
   - A centered, full-screen card appears featuring:
     - The orange geometric star brand mark and `"QRPass"` wordmark.
     - Subtitle: `"Sign in with your supervisor or administrator credentials to start verifying attendees."`
     - Clean Username and Password inputs.
     - Primary `"Sign In"` button.
   - If incorrect credentials are submitted, an inline error banner appears (`"Invalid username or password"`). Access remains strictly blocked.
   - Upon successful authentication, the login gate smoothly fades out, revealing the top bar, active event selector, and role-appropriate navigation tabs (Scanner & Reports for supervisors; Roster, Supervisors, and Admin for administrators).

2. **User Profile Dropdown Navigation**:
   - In the top header, the user chip displays an avatar icon (`👤`), operator name (e.g., `"Supervisor Alex"`), role badge, and a caret (`▾`).
   - Clicking toggles an accessible dropdown menu:
     - **Profile Header**: Shows full name, role, and current session status.
     - **Switch Account**: Opens a modal to sign into a different operator or admin account without clearing active event context.
     - **Sign Out**: Calls `/api/auth/logout`, stops active camera video feeds, clears cached tokens, and returns directly to the full-screen login gate.
   - Outside click or `Escape` key closes the dropdown cleanly.

3. **Active Session Restore**:
   - Returning to the app with a valid token stored in `localStorage` checks `/api/auth/me`. If valid, the user directly enters the workspace without delay. If invalid or revoked, the login screen is displayed.

### Visual Identity & Theme
- **Color Discipline**: Strict 60-30-10 palette using deep canvas (`#12243a`), crisp card surface (`#ffffff`), subtle borders (`#d9e2ec`), and high-intent orange accent (`#ff662a`).
- **Typography**: Clean display sans with tabular figures (`tabular-nums`) for numeric data.
- **Micro-Interactions**: Dropdown menu opens with a subtle 150ms settling slide (`cubic-bezier(0.16, 1, 0.3, 1)`), visible focus rings for accessibility, and smooth state transitions.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Full-Screen Gateway vs. Dismissible Modal Overlay**:
  - *Chosen Approach*: Full-screen standalone gate (`#auth-gate`) that wraps the login form and hides the `<header>` and `<main>` shells.
  - *Why*: Modal overlays can accidentally be dismissed by clicking outside, pressing Escape, or inspecting DOM elements, exposing interface controls. Hiding the application shell until `currentUser` is populated guarantees zero accidental exposure of event rosters or scanner controls.

- **Decision 2: Dropdown Menu vs. Multiple Header Buttons**:
  - *Chosen Approach*: Single interactive profile button triggering a dropdown menu with both Switch Account and Sign Out actions.
  - *Why*: Conserves critical horizontal space on mobile screens (where multiple buttons cause wrapping or clip the event selector), adhering to the top-bar spatial contract.

- **Decision 3: Complete Hardware & Stream Cleanup on Sign Out**:
  - *Chosen Approach*: `stopCamera()` is invoked upon sign out, terminating media tracks and releasing camera hardware immediately.
  - *Why*: Prevents mobile camera indicator lights from staying active when an operator signs out.

---

## 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                       App Boot Lifecycle                    │
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
│      #auth-gate (Locked)    │ │   Application Workspace     │
│ - Top header hidden         │ │ - Header & Nav tabs visible │
│ - Main shell hidden         │ │ - Role-based tab filtering  │
│ - Mandatory credentials     │ │ - User Profile Dropdown:    │
│ - Error feedback banner     │ │    ├── Switch Account       │
│ - On success: showApp()     │ │    └── Sign Out -> Gate     │
└─────────────────────────────┘ └─────────────────────────────┘
```

### Component & DOM Changes

1. **`public/index.html`**:
   - Add `#auth-gate` section containing the full-screen branded login card before `<header>`.
   - Update `#user-badge-container` in `<header>` to an interactive button with a dropdown container (`#user-profile-menu`) containing:
     - User details header.
     - `#menu-btn-switch-account` (Switch Account).
     - `#menu-btn-sign-out` (Sign Out).
   - Retain `#modal-login` specifically for the "Switch Account" dialog while inside the workspace.

2. **`public/style.css`**:
   - Add styles for `.auth-gate`, `.auth-card`, and responsive centering.
   - Add styles for `.profile-dropdown-wrapper`, `.profile-menu`, `.profile-menu-header`, and `.profile-menu-item`.
   - Ensure mobile touch targets ($\ge 44\text{px}$) and clear hover/focus states.

3. **`public/app.js`**:
   - Implement `showAuthGate()` and `showApp()`.
   - Wire the `#form-gate-login` submit handler with error messaging and transition into `showApp()`.
   - Wire profile dropdown toggle, outside click dismissal, and escape key listener.
   - Wire `Sign Out`: calls `/api/auth/logout`, terminates camera stream, wipes token, and triggers `showAuthGate()`.
