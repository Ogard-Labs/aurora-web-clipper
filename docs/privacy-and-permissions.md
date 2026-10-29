# Privacy and permissions

Aurora Web Clipper captures content only when you open the extension and
choose a capture action. It does not run continuous page collection and does
not include telemetry or analytics.

## Browser permissions

| Permission | Why it is required |
| --- | --- |
| `activeTab` | Gives temporary access to the active page after you invoke the extension. |
| `scripting` | Runs the capture script in that user-invoked active page to read its title, URL, description, and selected content. |
| `identity` | Opens the Google sign-in window when you choose **Continue with Google**. The provider returns to AuroraCloud, which hands a one-time code back to this extension; the extension never sees your provider password. |
| `storage` | Stores connection settings and the signed-in extension session in browser-managed extension storage. |
| `host_permissions` | Allows network requests to the default AuroraCloud API (`https://api.aurora.ink`), the coexisting legacy host (`https://api.auroradocs.eu`), and local development servers (`http://localhost`, `http://127.0.0.1`). Page capture uses `activeTab` and `scripting`, not broad host access. |
| `optional_host_permissions` | Declares that the extension may request access to a user-configured HTTPS self-hosted API origin at runtime. The user must grant this access before the clipper can talk to that origin. Non-localhost HTTP origins are not supported — use HTTPS for any self-hosted API. |

The `activeTab` and `scripting` permissions inspect only the active page in
response to a user-invoked clip action. The extension does not inspect other
tabs in the background. Browser-protected pages may reject capture even when
the active tab permission is granted.

## Data stored in the browser

- `chrome.storage.sync` stores the API URL and Workspace ID so those connection
  settings can follow the browser profile where extension sync is enabled.
- `chrome.storage.local` stores the short-lived interactive session only while
  pairing, then stores scoped clipper credentials, authorization metadata, and
  encrypted retry envelopes. Retry payloads are encrypted with a browser-local
  key; the extension does not persist capture plaintext.
- The email and password entered during sign-in are sent to the configured API
  for authentication; they are not saved in extension storage.

The clipper's interactive browser session is separate from Aurora MCP
authentication. MCP tokens are not used by the Web Clipper.

## Data sent when clipping

When you choose **Clip page** or **Clip selection**, the extension reads the
active page's title, URL, description, and current selection. For an encrypted
workspace it seals the capture with the workspace capture public key and sends
only the capture ID, generation, and opaque envelope to the configured API.
The API cannot decrypt or materialize the clip until a trusted unlocked
Aurora client does so. Selection capture may include basic HTML formatting
and resolved links from the selected content.

Review the active page and selection before clipping confidential information.
A self-hosted API URL is controlled by its operator, whose privacy and retention
terms apply to data sent there.

## Sign-out, uninstall, and server data

- **Sign out** deletes the interactive Aurora session from
  `chrome.storage.local`; it does not revoke an existing scoped pairing.
- **Disconnect** removes scoped clipper credentials and workspace authorizations
  from this browser. An administrator can also revoke the clipper in Aurora.
- **Uninstall** removes the extension and clears its `chrome.storage.local`
  data from that browser profile, including the session. Because connection
  settings use browser sync, they may already exist in another synced browser
  profile; remove the extension there as well if needed.
- Neither action deletes clips already stored in Aurora. Manage those
  records and account data through Aurora or the relevant workspace
  administrator.

Aurora Web Clipper contains no telemetry, analytics, advertising SDK, or
background browsing-history collection.
