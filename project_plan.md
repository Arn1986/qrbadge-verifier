# qr-badge-verifier — Project plan

Status: agreed scope, 26 September 2026

## Goal

Provide a public web page that scans time-based-badge QR codes using a phone camera or PC webcam, or accepts pasted QR hex. Verify the badge online and show its identifier, validity result, and actual start and end times in the scanning device's local time.

## Confirmed decisions

| Topic | Decision |
| --- | --- |
| Access to scanner | Anyone with the link; no scanner login |
| Connectivity | Online; verification runs on the Cloudflare Worker |
| Scan flow | One QR at a time; hold the result until the operator presses **Scan again** |
| Reuse | The same QR can be scanned multiple times within its valid window |
| Results | Valid, Not valid yet, Expired, and Cannot verify; also report malformed or unsupported QR format clearly |
| Successful decoding | Show decimal badge identifier and actual start/end date and time, even when outside the valid interval |
| Display timezone | Scanning device's local timezone, explicitly labeled; server UTC clock determines validity |
| Admin | Basic Auth protected page to set AES key and view scan history |
| Key changes | Single active key; replacing it immediately rejects QRs encrypted with the old key |
| History | Admin only; default 30-day retention, adjustable on admin page |
| Deployment | GitHub repository connected to Cloudflare automatic deployment |
| Issuer coordination | Operator manually configures the same AES key in time-based-badge; changing the issuer is outside this project |

## Protocol compatibility

The current expected time-based-badge payload is 84 hex characters encoding 42 bytes: protocol byte `0x01`, 12-byte AES-GCM IV, 13-byte ciphertext, and 16-byte authentication tag. AES-128-GCM uses a 16-byte (32-character hex) key. The decrypted 13 bytes contain a 4-byte unsigned big-endian identifier, one-byte time type, a 4-byte unsigned big-endian start, and a 4-byte unsigned big-endian end. Version 1 targets time type `0x02`: UTC Unix epoch seconds. Verify these details against a real QR from the current issuer before implementation; fail explicitly on unsupported protocol or time type.

Accept upper- or lowercase pasted hex after trimming surrounding whitespace. Reject other contents or incorrect length before decryption. AES authentication failure cannot distinguish an incorrect key, an altered QR, or incompatible encrypted content; display a neutral Cannot verify message. Do not claim to distinguish those causes.

Time rule: `start <= serverNow < end`; equal start is valid, equal end is expired. Reject invalid ranges (`end <= start`) as malformed decrypted data. Decrypted timestamps are returned as UTC instants for local formatting in the browser, together with server-derived result and scan time. Do not use the phone's clock for the validity decision.

## Proposed architecture

| Component | Responsibility |
| --- | --- |
| Static web UI | Camera permission and camera choice, QR decoding, pasted hex input, result display, Scan again, local time formatting |
| Cloudflare Worker | HTTPS pages and API, strict QR parsing, AES-GCM decryption, server-time validity decision, scan history, admin authentication |
| Cloudflare D1 | Encrypted active AES key record, scan history, configurable retention setting |
| Cloudflare Worker secrets | Separate storage encryption key and Basic Auth credentials; never put them in client code or Git |
| Scheduled cleanup | Remove history older than configured retention period; default 30 days |

Proposed routes: `/` for scanner, `POST /api/verify` for verification, `/admin/` for key and history, authenticated `/api/admin/*` routes for key replacement, settings, and paginated history. No verification response or admin response should be cached. Keep the AES key, raw QR text, and Basic Auth password out of history and application logs.

Protect both the admin page and all admin APIs with Basic Auth over HTTPS. Encrypt the badge AES key with a separate randomly generated wrapping key held as a Worker secret before writing it to D1. Do not return the badge AES key after it has been saved; show only configured status, update time, and a short fingerprint to help operators compare keys. Confirm key replacement before activating it. Read the active key for each verification so a replacement takes effect without a redeployment or application key cache. Keep the scanner public as requested, with basic limits on input size and request rate.

## Scanner experience

1. Open the page; request camera access only when the operator starts scanning. Prefer a rear camera on phones and offer camera selection when multiple devices are available.
2. Scan a QR or paste its hex payload. Submit the exact payload to the Worker over HTTPS; no badge decryption in the browser.
3. Stop scanning once a QR is captured so a single displayed QR produces one result and one history entry.
4. Show one of:
   - **Valid**: identifier, start, end, and local timezone.
   - **Not valid yet**: identifier, start, end, and local timezone.
   - **Expired**: identifier, start, end, and local timezone.
   - **Cannot verify**: wrong or damaged encrypted content; no identifier/times are available.
   - **Unsupported / malformed QR**: clear format-specific message; no identifier/times are available.
   - **Connection error**: verification could not reach the server; do not label it invalid.
5. **Scan again** resets the result and restarts the camera. Pasted hex remains available as a fallback when camera permission is denied or a camera is unavailable.

## Scan history

Record scan time (UTC), outcome, and source (`camera` or `paste`). For successfully decoded QRs, record identifier and decoded start/end instants. For failed authentication or parsing, record failure category without the raw QR. Display history newest first with pagination in the authenticated admin page; render dates in the admin device's local time. Retention defaults to 30 days and is configurable to a positive number of days. A daily scheduled task deletes records older than the configured setting; changing the setting takes effect at the next cleanup.

## Implementation milestones

1. **Foundation:** GitHub repository, Cloudflare Worker with static assets, D1 migrations, local development configuration, and deployment instructions.
2. **Protocol and API:** strict hex parsing, AES-128-GCM decryption, UTC time type handling, server-side validity checks, and known-good test vectors from time-based-badge.
3. **Scanner UI:** responsive camera scanner, camera switching, paste input, result states, local date formatting, and Scan again behavior.
4. **Admin and audit:** Basic Auth, wrapped AES key replacement, current-key status/fingerprint, paginated scan history, adjustable retention, and daily cleanup.
5. **Release checks:** test on phone and desktop, verify a real issuer QR, and check start/end boundaries, wrong key, malformed QR, no camera permission, offline/network failure, repeated scanning, key replacement, and history cleanup. After local testing, push to GitHub and let Cloudflare deploy automatically.

## Acceptance criteria

- A QR generated by time-based-badge with the matching key returns its decimal identifier and correct actual start/end instants, formatted locally on both phone and desktop.
- Server time controls Valid, Not valid yet, and Expired; a changed device clock only affects its displayed local formatting.
- A wrong key, tampered payload, unsupported time type, and non-hex input produce appropriate safe errors without claiming an invalid authentication result is definitely a wrong key.
- Replacing the AES key via the admin page makes old-key QRs fail on subsequent verification requests; new-key QRs work when the issuer has been updated.
- Scan history is accessible only to the administrator, defaults to 30-day retention, and follows a changed retention setting after the next scheduled cleanup.
- Both camera and pasted hex work; a result stays visible until Scan again; repeated scans of the same still-valid QR are accepted.

## Scope boundary

Verification is self-contained: it checks that the QR is authentic for the current key and currently inside its encoded time window. It does not query time-based-badge for revocation status, identity details, or whether a copied QR was already presented. A copied QR can be used again during its validity window. Issuer key updates are a separate manual operation.
