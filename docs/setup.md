# Setup

This guide installs the latest published Aurora Web Clipper, connects it to
one AuroraCloud-compatible workspace, and verifies a first capture.

## Requirements

- a Chromium-based browser with Manifest V3 extension support
- an AuroraCloud or compatible self-hosted workspace
- the workspace API URL and Workspace ID
- an Aurora email and password with access to the workspace

Browser-only and Local folders workspaces are not supported because the
extension sends clips to an AuroraCloud-compatible API.

## Install the release

1. Download the latest published ZIP from the
   [Aurora download page](https://aurora.ink/download.html) or the
   [GitHub releases page](https://github.com/Ogard-Labs/aurora-web-clipper/releases).
2. Extract the ZIP to a stable folder that will remain on your computer.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Select **Load unpacked** and choose the extracted folder containing
   `manifest.json`.
6. Pin Aurora Web Clipper from the browser Extensions menu if desired.

Do not delete or move the extracted folder while the extension is installed.

## Connect Aurora

1. Open the extension popup.
2. Keep `https://api.aurora.ink`, or enter the API URL supplied by your
   self-hosted administrator. Self-hosted APIs must use HTTPS; `http://localhost`
   and `http://127.0.0.1` are allowed for local development.
3. In Aurora, open **Settings → Workspace** and copy the value from
   **Workspace ID**, then enter it in the popup. For a self-hosted workspace,
   ask its administrator for both the API URL and Workspace ID.
4. Enter your Aurora email and password, then select **Sign in securely**. Or
   select **Continue with Google**, **GitHub**, **Apple** or **Microsoft** if
   you sign in to Aurora that way, and finish in the window that opens.
5. If MFA is required, enter an authenticator code or request an email code.

The extension stores its refreshable session in `chrome.storage.local`; the API
URL and Workspace ID use extension sync storage. MCP tokens are not used by the
Web Clipper and must not be pasted into it.

## Verify a capture

1. Open a normal web page that you are allowed to save.
2. Open the extension and choose **Clip page**.
3. Open the Aurora Inbox and confirm the bookmark title and source URL.
4. Select text on a page, open the extension, and choose **Clip selection**.
5. Confirm the Inbox page contains the selected content and source link.

Browser-managed pages, extension pages, and protected store pages cannot be
captured.

## Update the extension

1. Download and extract the new release to a stable folder.
2. Open `chrome://extensions`.
3. The **Reload** path preserves the existing local session: replace the files
   in the currently loaded folder and select **Reload** on the extension card.
4. Alternatively, remove the old entry and use **Load unpacked** with the new
   folder. Removal deletes the local session. Open the popup, sign in again,
   and complete MFA again if prompted.
5. Verify the API URL, Workspace ID, and sign-in state.
6. Repeat one **Clip page** verification.

**Updating from 0.2.x:** the first release with provider sign-in adds a
manifest `key`, which gives the extension a fixed ID. The browser treats it as
a new extension once, so sign in and pair again. The old entry under
**Authorized clippers** in Aurora is no longer used and can be revoked. Later
updates keep the session as before.

## Sign out or Uninstall

- Select **Sign out** in the popup to delete the local Aurora session.
- Remove the extension from `chrome://extensions` to delete its local session
  from that browser profile.
- Connection settings may remain in another synced browser profile; remove the
  extension there as well when required.
- Clips already stored in Aurora are not deleted when the extension is
  removed.

For common failures, see [Troubleshooting](troubleshooting.md). For storage and
permission details, see [Privacy and permissions](privacy-and-permissions.md).
