# Troubleshooting

## The extension will not load

- Extract the release archive before selecting **Load unpacked**.
- Select the folder that directly contains `manifest.json`.
- Confirm Developer mode is enabled at `chrome://extensions`.
- If the browser reports a manifest error, download a fresh release archive and
  extract it to a new folder.

## Sign-in fails

- Confirm the API URL is correct. The production service is
  `https://api.aurora.ink`.
- Confirm the email and password belong to an Aurora account, not an MCP
  integration. MCP tokens cannot sign in to the Web Clipper.
- If MFA is required, enter the current authenticator code or request an email
  code and check the account's inbox.
- For a self-hosted service, confirm the service is reachable from the browser
  and permits the extension's requests.
- No **Continue with …** buttons: the server does not allow provider sign-in
  for this extension. Its administrator adds
  `aknfkfnafcppbgknjbibgpcgfhlpgcme` to `AURORA_AUTH_CLIPPER_EXTENSION_IDS`.
  Email and password sign-in still works.
- The provider window closed and nothing happened: the sign-in was cancelled.
  Select the button again.
- "Not linked to your Aurora account yet": select **Email me a link**, open the
  link from the email, then sign in with the provider again.

## Pairing or encrypted capture fails

- Sign in, choose **Enable encrypted capture**, and approve the displayed code
  in a trusted Aurora tab while the destination workspace is unlocked.
- Pairing codes expire after a short window. Cancel the old request and start a
  new pairing if approval is delayed.
- If the clipper says authorization is stale, disconnect it and pair again. A
  workspace administrator may have revoked this browser or rotated its capture
  key.
- A successful encrypted clip may briefly show as pending. It appears in Inbox
  after a trusted Aurora client unlocks and materializes the workspace.

## A clip is not saved

- Confirm the Workspace ID belongs to an AuroraCloud or compatible self-hosted
  workspace that the signed-in account can access. Browser-only and Local
  folders workspaces are unsupported.
- Re-pair the clipper if its scoped authorization is no longer valid. Direct
  session capture remains available for non-E2EE workspaces.
- Keep the source page active until the success or error message appears.
- Browser settings pages, extension pages, web-store pages, and other protected
  URLs may block extension scripts. Try a normal `https://` page.
- To clip a selection, highlight the content before opening the extension.

## Settings or sign-in state changed

The API URL and Workspace ID use `chrome.storage.sync`, while the Aurora
session uses `chrome.storage.local`. Browser profile changes, extension sync
settings, clearing site/extension data, or reinstalling the extension can
therefore affect them differently.

## Request support

For reproducible non-sensitive defects, open a GitHub issue and include the Web
Clipper version, browser version, expected result, observed result, and sanitized
reproduction steps. Never include credentials, MFA codes, session values,
workspace contents, or production user data.

Report suspected security vulnerabilities privately according to
[SECURITY.md](../SECURITY.md).
