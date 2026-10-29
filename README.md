# Aurora Web Clipper

Aurora Web Clipper is a Manifest V3 browser extension that saves the active
page or selected content to the Inbox of an AuroraCloud workspace.

For an end-to-end installation walkthrough, use the dedicated
[Setup guide](docs/setup.md).

## Requirements

- A Chromium-based browser that supports Manifest V3 extensions
- An AuroraCloud or compatible self-hosted workspace
- Your workspace's API URL and Workspace ID
- An Aurora account with access to that workspace

Browser-only workspaces and Local folders workspaces are not supported because
the extension must send clips to an AuroraCloud-compatible API.

## Install from a release

1. Download the latest published Aurora Web Clipper ZIP from the
   [Aurora download page](https://aurora.ink/download.html) or the
   [public releases page](https://github.com/Ogard-Labs/aurora-web-clipper/releases),
   then extract it to a folder you will keep on your computer.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted extension folder (the
   folder containing `manifest.json`).
5. Pin Aurora Web Clipper from the browser's Extensions menu if you want it
   visible in the toolbar.

Do not delete or move the extracted folder while the extension is installed.

Release artifacts are published to GitHub Releases first, then mirrored to the
Aurora downloads host. See [release mirror operations](docs/release-mirror.md)
for the protected workflow and required deployment setup.

## Connect Aurora

1. Open the extension popup.
2. Keep the production API URL, `https://api.aurora.ink`, or enter the URL
   supplied by your self-hosted administrator. Self-hosted APIs must use HTTPS;
   `http://localhost` and `http://127.0.0.1` are allowed for local development.
3. In Aurora, open **Settings → Workspace**, copy **Workspace ID**, and
   enter it in the popup. For a self-hosted workspace, ask its administrator
   for both the API URL and Workspace ID.
4. Enter your Aurora email and password, then select **Sign in securely**.
5. If prompted for MFA, use your authenticator code or request and enter an
   email code.
6. Select **Enable encrypted capture**, open Aurora in a trusted tab, and
   approve the one-time pairing code for the unlocked workspace.

Pairing exchanges the interactive session for a scoped clipper credential. The
extension then encrypts captures locally and sends only opaque envelopes to the
API. After pairing, clipping continues while Aurora and the desktop app are
closed. The interactive session is removed after the exchange; scoped
credentials and the selected workspace key metadata stay in
`chrome.storage.local`.
MCP tokens are not used by the Web Clipper and should not be pasted into it.

See [Privacy and permissions](docs/privacy-and-permissions.md) for the complete
storage, page-access, and deletion behavior.

## Capture content

Open the page you want to save, select the extension, and choose:

- **Clip page** to create an encrypted Inbox bookmark with the page title, URL,
  and description.
- **Clip selection** to create an encrypted Inbox page containing the selected
  text as a quote. Basic formatting, links, and ordered or unordered lists are
  preserved; relative links are resolved against the source page.

Encrypted captures are held in a server-side opaque pending inbox until a
trusted Aurora client unlocks the workspace. A retry uses the same capture
ID and envelope, so a timeout cannot create duplicate clips. If the workspace
capture key rotates, the locally sealed retry is re-encrypted after the client
refreshes its authorization.

The `activeTab` and `scripting` permissions allow inspection only after you
invoke the clipper on the active page. Some browser-managed pages, extension
pages, and protected store pages cannot be captured.

## Update

1. Download and extract the new release to a stable folder.
2. Open `chrome://extensions`.
3. To preserve the existing local session, replace the files in the currently
   loaded folder and select **Reload** on the extension card.
4. Alternatively, remove the existing entry and use **Load unpacked** with the
   new folder. Removal deletes the local session, so sign in again and complete
   MFA again if prompted.
5. Open the popup and confirm the API URL, Workspace ID, and sign-in state.

## Sign out or uninstall

Select **Sign out** in the popup to delete the locally stored Aurora session.
The API URL and Workspace ID remain so the extension can be reconnected easily.
Removing the extension deletes its local session from that browser profile.
Connection settings use browser sync and may exist in another synced profile;
remove the extension there as well if needed. Clips already saved in Aurora
are not deleted.

## Support and security

For setup and capture failures, see [Troubleshooting](docs/troubleshooting.md).
For reproducible non-sensitive defects, open a GitHub issue. Do not put account
details, credentials, session values, workspace contents, or production user
data in an issue.

Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md). Please do not open a public issue for a security
report.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) before submitting a change.

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The default API is `https://api.aurora.ink`. The previous
`https://api.auroradocs.eu` hostname remains supported, including existing saved
connection settings. This rebrand keeps the extension identity, archive names,
local sessions, and encrypted capture protocol unchanged.
