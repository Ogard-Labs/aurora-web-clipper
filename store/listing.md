# Chrome Web Store listing

Text and answers for the Chrome Web Store dashboard. Upload
`dist/auroradocs-web-clipper-<version>-chrome-web-store.zip` from
`pnpm package:store`; the store refuses the manifest `key`, so that build
leaves it out.

## Store listing

- **Name:** Aurora Web Clipper
- **Summary (132 characters max):** Save pages, selections, screenshots and articles to your Aurora Inbox. Encrypted workspaces stay sealed.
- **Category:** Productivity
- **Language:** English
- **Screenshots (1280 × 800):** `store/screenshots/`
- **Homepage:** https://aurora.ink
- **Support:** https://github.com/Ogard-Labs/aurora-web-clipper/issues
- **Privacy policy:** https://aurora.ink/privacy

### Description

Aurora Web Clipper saves what you find on the web to the Inbox of your Aurora workspace.

- **Clip page** saves the title, link and description as a bookmark.
- **Clip selection** saves the text you selected as a quote, with its formatting and links.
- **Clip article** saves the readable text of an article, without menus, ads or comments.
- **Screenshot** lets you drag a box on the page and saves that part as an image.
- **Right-click** any page, selection, link or image to clip it without opening the popup, or press **Alt+Shift+S** to clip the page.
- Add a **note** and **tags** before you save, and **Open in Aurora** right after.
- The clipper tells you when a page is **already in Aurora**.

End-to-end encrypted workspaces stay sealed: after you approve this browser once in Aurora, the clipper encrypts every clip on your device, and AuroraCloud only stores the sealed envelope until Aurora unlocks it. Screenshots, images and tags are not available for encrypted workspaces yet, and the clipper refuses to send them rather than send them unencrypted.

You need an Aurora account. Sign in with email and password, or with Google, GitHub, Apple or Microsoft.

## Privacy practices

**Single purpose:** Save web content the user chooses (a page, selection, article, link, image or screenshot) to the user's own Aurora workspace.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Reads the current page, and takes the screenshot, only after the user clicks the toolbar button, a right-click menu item or the keyboard shortcut. |
| `contextMenus` | Adds Clip page, Clip selection, Clip link and Clip image to the right-click menu. |
| `identity` | Opens the Google, GitHub, Apple or Microsoft sign-in window when the user chooses one. |
| `scripting` | Runs the clipper's page reader, crop overlay and bundled article reader in the page the user chose to clip. |
| `storage` | Keeps the sign-in session, settings and encrypted retry envelopes in the browser. |
| Host `https://api.aurora.ink/*`, `https://api.auroradocs.eu/*` | Sends clips to AuroraCloud. |
| Host `http://localhost/*`, `http://127.0.0.1/*` | Lets developers and self-hosters use a local Aurora server. |
| Optional host `https://*/*` | Asked for only when the user enters a self-hosted Aurora API address, and only for that address. |

**Remote code:** No. All code, including Mozilla Readability, is in the package.

**Data usage** (the boxes to tick):

- Personally identifiable information: yes (the account email, shown in the popup and sent to Aurora at sign-in).
- Authentication information: yes (the Aurora session, kept in extension storage).
- Website content: yes (only the page, selection, article, link, image or screenshot the user chooses to clip).
- Web history: no. Only the URL of a page the user clips is sent.
- All others (health, financial, personal communications, location, user activity): no.

Certify: data is not sold, not used or transferred for purposes unrelated to the single purpose, and not used for creditworthiness or lending.

## After publishing

The store gives the extension its own ID. Provider sign-in only works once
AuroraCloud allows that ID: add it to `AURORA_AUTH_CLIPPER_EXTENSION_IDS`
beside `aknfkfnafcppbgknjbibgpcgfhlpgcme` on the production API.
