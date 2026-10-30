# Blackboard MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for Blackboard Learn. Connect your own institution's Blackboard site to an MCP client, navigate courses, inspect pages, download materials, and optionally look up academic weeks using your own calendar.

The server uses Playwright and a visible Microsoft Edge window (Chrome or Chromium can be configured instead). It is configurable for different institutions and does not assume a particular university, identity provider, or academic calendar. It uses normal browser pages and your existing access permissions.

## Requirements

- Windows with Microsoft Edge installed. macOS and Linux work with `browserChannel` set to an installed Chrome or Chromium, but are less tested.
- Node.js 20 or later.
- An account with access to your institution's Blackboard site.
- An MCP client that supports local stdio servers.

## Setup

```powershell
git clone https://github.com/UKplus8HRS/bb-mcp.git
cd bb-mcp
Copy-Item config.example.json config.local.json
cd mcp
npm.cmd ci
```

Edit `config.local.json` in the repository root:

```json
{
  "startUrl": "https://blackboard.example.edu/",
  "allowedHosts": ["portal.example.edu"],
  "timeZone": "America/New_York"
}
```

Replace the example URL with your institution's Blackboard entry URL. Its hostname and subdomains are allowed automatically. Add only trusted extra hosts, such as a separate student portal, to `allowedHosts`; use bare hostnames without schemes, ports, paths, or wildcards. Direct navigation requires HTTPS and rejects embedded credentials. This allowlist checks `blackboard_open`; links and sign-in redirects follow normal browser behavior and are not a browser-wide sandbox.

`browserChannel` selects `msedge` (default), `chrome`, or `chromium`.

`timeZone` accepts an IANA time zone, such as `Europe/London` or `Asia/Shanghai`, and defaults to the computer's time zone. To use a configuration outside the repository, set the `BB_CONFIG` environment variable to its absolute path.

### Connect an MCP client

Use `node` as the command and the absolute path to `mcp/server.js` as its argument. For example, in Codex's `config.toml`:

```toml
[mcp_servers.blackboard_playwright]
command = "node"
args = ['C:\path\to\bb-mcp\mcp\server.js']
startup_timeout_sec = 60
tool_timeout_sec = 90
```

Call `blackboard_login`, then complete your institution's sign-in and MFA in Edge. Passwords and verification codes should be entered by you in the browser. The server does not require a password or API token in its configuration.

### Institution-specific sign-in

The server recognizes common institution/SSO login link labels and visible Blackboard Ultra navigation or logout links. If your institution uses a different label or theme, add either setting to your local configuration:

```json
{
  "startUrl": "https://blackboard.example.edu/",
  "loginButtonName": "Sign in through Example University",
  "signedInSelector": "a[href*='/webapps/login/'][href*='action=logout']"
}
```

`loginButtonName` is the exact visible text of an institution login link or button. `signedInSelector` is a CSS selector for an element that is visible only after sign-in. These settings are optional. Custom themes, localized pages, and identity providers may require manual navigation or tailored selectors; configuration support does not mean every institution has been tested.

## Tools

| Tool | Purpose |
| --- | --- |
| `blackboard_login` | Open the configured site and report sign-in state. |
| `blackboard_snapshot` | Read page text and numbered interactive elements, including those inside frames. |
| `blackboard_open` | Open an HTTPS URL on a configured host. |
| `blackboard_click` | Click an element from the latest snapshot. |
| `blackboard_type` | Fill a field, optionally pressing Enter. Password and verification-code fields are refused. |
| `blackboard_press` | Send a keyboard key. |
| `blackboard_download` | Save a file by clicking a download control or fetching an allowed URL; optionally archive it. |
| `blackboard_tabs` | List tabs or select one by its one-based index. |
| `blackboard_screenshot` | Save a screenshot for visual inspection. |
| `blackboard_academic_week` | Look up a date in an optional academic calendar. |
| `blackboard_courses` | List your courses through the REST API. |
| `blackboard_contents` | List a course's content tree or a folder's children through the REST API. |
| `blackboard_announcements` | List course announcements through the REST API. |
| `blackboard_attachments` | List a content item's files with download URLs. |
| `blackboard_close` | Close the browser and release its profile lock. |

Refresh snapshots after navigation before reusing element references. Page text in snapshots is wrapped in untrusted-content markers, and tools carry MCP annotations (`readOnlyHint`, `destructiveHint`) that clients can use to decide when to ask for confirmation. Ask your assistant to obtain your explicit approval before submitting assignments, posting, deleting content, or changing settings; the server exposes browser controls and does not enforce an approval workflow. Treat page content and downloaded files as untrusted data.

### REST API tools

The `courses`, `contents`, `announcements`, and `attachments` tools call the Blackboard Learn public REST API (`/learn/api/public/v1`) with the signed-in browser session instead of navigating pages. They need no API key, but not every institution accepts session access; if they report that the session was not accepted after a successful sign-in, use the browser tools instead. Course ids such as `_123_1` come from `blackboard_courses`. Attachment URLs can be passed to `blackboard_download` as `url`.

## Optional academic calendar

No university calendar is bundled. Without your own entries, calendar results include local dates and explicitly report that no academic week mapping is configured.

Add `calendar` to `config.local.json` if you want week numbers. The following dates are illustrative; replace them with your institution's published dates:

```json
{
  "startUrl": "https://blackboard.example.edu/",
  "calendarSources": ["https://www.example.edu/academic-calendar"],
  "calendar": [
    {
      "start": "2026-09-07",
      "end": "2026-12-07",
      "firstWeek": 1,
      "weekNames": { "6": "Reading week" }
    },
    {
      "start": "2026-12-07",
      "end": "2027-01-11",
      "phase": "Winter break"
    }
  ]
}
```

Periods include `start` and exclude `end`, and must not overlap. `firstWeek` numbers successive seven-day blocks from the period start. Omit it for breaks or assessment periods; optionally set `phase` and `label`. Split periods when week numbering pauses or restarts. Course-specific week labels and timetables must still be checked on the relevant course or student portal.

## Local data and privacy

By default, each Blackboard hostname gets its own Edge profile at `~/.blackboard-mcp/<hostname>/edge-profile`. Set `profileDir` to use another location; relative paths resolve from the configuration file's directory. A profile can contain authentication cookies, so keep it local. A busy profile returns `BUSY` instead of launching a second owner.

Downloads and screenshots go to `codex-blackboard-downloads` in the system temporary directory. A page snapshot sends the visible page content to your MCP client, so use a client you trust.

The repository ignores local configuration, browser profiles, credentials, environment files, downloaded course materials, and common key/cookie files. Do not commit your profile, screenshots, downloaded course content, or any credentials, even to a private fork.

### Archive downloads

Pass `course` (and optionally `section`) to `blackboard_download` to move the file straight into `materials/<course>/<section>/`. To archive a file that was saved earlier, run from the repository root:

```powershell
node scripts/archive-blackboard-file.mjs <temporary-path> <course> <section> <original-filename>
```

The script moves a captured download into `materials/`, reuses identical files, and keeps numbered versions when contents differ. `materials/` is ignored by Git.

## Tests

```powershell
cd mcp
npm.cmd test
```

Tests cover configuration validation, multiple institution hostnames, URL restrictions, calendar boundaries and time zones, Ultra/classic login and external SSO page fixtures, tab recovery, frames, refused secret fields, URL downloads and archiving, and REST API paging against a local fixture server. They use a temporary headless browser profile with intercepted pages and temporary files, and do not sign in to a real school account. Set `BB_BROWSER_CHANNEL=chromium` (or `chrome`) to run them without Edge. GitHub Actions runs them on Windows with Edge.

## License

[MIT](LICENSE). This project is independent and is not affiliated with Blackboard or any university.
