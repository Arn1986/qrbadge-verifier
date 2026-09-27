# qr-badge-verifier

Public online camera / paste-hex verifier for time-based-badge QR codes, plus Basic Auth protected key management and scan history. The Worker determines validity using its clock and sends UTC instants to the browser, which displays them in local time.

Scan sounds are on by default and can be muted with **Play result sounds**. A valid QR plays two short ascending approval beeps. Not valid yet, expired, unreadable encrypted content, malformed hex, and unsupported QR formats play two lower denial beeps. Connection errors, rate limits, and server failures stay silent because no validity decision was made. Browsers normally require a click or tap before audio can start; starting the camera, submitting pasted hex, and turning sound on unlock the audio context.

## Requirements

- Node.js 20.19 or later, npm, Cloudflare Workers and D1, GitHub repository for automatic deployment.
- A 32-character hexadecimal badge AES-128 key that matches the separately managed time-based-badge issuer. Do not put this key in a source file or issue tracker.

## Local setup (Windows PowerShell)

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
# Replace placeholders in .dev.vars; use 64 randomly generated hex characters for STORAGE_KEY_HEX.
npm test
npm run db:local
npm run dev
```

To make a new 32-byte wrapping key in PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Open the localhost URL Wrangler prints; visit `/admin/` to authenticate with credentials from `.dev.vars` and enter the issuer's AES key. Browser camera access is permitted on localhost and HTTPS. `npm run build` copies the pinned jsQR library into `public/vendor/` for self-hosted camera decoding.

## Production setup and deployment

1. Create a new private GitHub repository called `qr-badge-verifier` and commit this folder's files, including `package-lock.json`. Never commit `.dev.vars`. The generated `public/vendor/jsQR.js` can remain in the repository or be recreated in the build.
2. Authenticate Wrangler to the correct Cloudflare account and run `npx wrangler d1 create qr-badge-verifier`. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the returned UUID.
3. Run `npm run db:remote` to create the production tables before launching the Worker.
4. Connect the GitHub repository to **Cloudflare Workers Builds**, with project root at the repository root, build command `npm run build`, and deploy command `npx wrangler deploy`. Keep the Worker name `qr-badge-verifier`. Subsequent pushes automatically deploy; there is no need to run `npm run deploy` for normal updates.
5. Set three Worker secrets through Cloudflare: `STORAGE_KEY_HEX` (64 random hex characters, distinct from the badge key), `ADMIN_BASIC_USERNAME`, and `ADMIN_BASIC_PASSWORD` (a long unique password). Configure the production custom domain if desired and use HTTPS. Safeguard and back up the wrapping key: losing it prevents decrypting the configured badge key. If the wrapping key changes, re-enter the badge key through admin.
6. Open `/admin/`, authenticate, paste the current time-based-badge AES key (32 hex characters), and confirm replacement. The AES key is encrypted with `STORAGE_KEY_HEX` in D1; only metadata and a short fingerprint are returned to the administrator.
7. Verify a real badge QR on desktop and phone, test pasted hex and camera modes, and confirm status at the start and end boundaries. Confirm the generated QR is UTC time type `0x02` and protocol `0x01`.

The scheduler deletes scan history older than the administrator's retention setting daily at 02:00 UTC (30 days by default). You must manually update the issuer with the same AES key. When changing keys, old-key QRs stop verifying as soon as the verifier is updated.

## API and limits

- `POST /api/verify` accepts `{ "hex": "...", "source": "camera" | "paste" }` and returns a result, server scan timestamp, and decoded identifier/start/end if authentication succeeds.
- `/admin/` and `/api/admin/*` require HTTP Basic Auth. Do not reveal credentials or badge key to scanner users.
- Public scanner visitors can decode the badge identifier and times from any authentic QR they possess; scan records remain admin-only. No QR raw text or AES key is saved in history.
- The verifier checks QR authenticity and the encoded time window; it does not query the issuer for revocation or prevent replay within the window. Authentication failure cannot identify the exact cause (key mismatch or altered data).
- Public verification is limited to 120 requests per minute per client IP. Request buckets use keyed hashes rather than storing raw IP addresses, and expired buckets are removed daily. An additional Cloudflare edge rate limit may be added when traffic warrants it.
