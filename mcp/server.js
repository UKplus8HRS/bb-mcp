'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { chromium } = require('playwright');
const { z } = require('zod');
const { createServer } = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const execFileAsync = promisify(execFile);
const periodSchema = z.object({
  start: z.string(), end: z.string(), firstWeek: z.number().int().min(0).optional(),
  label: z.string().optional(), phase: z.string().default('Teaching week'),
  weekNames: z.record(z.string()).default({}),
}).strict();
const configSchema = z.object({
  startUrl: z.string().url(),
  allowedHosts: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i)).default([]),
  timeZone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  profileDir: z.string().min(1).optional(),
  loginButtonName: z.string().min(1).optional(),
  signedInSelector: z.string().min(1).optional(),
  calendar: z.array(periodSchema).default([]),
  calendarSources: z.array(z.string().url()).default([]),
}).strict();

function validateConfig(input) {
  const config = configSchema.parse(input);
  const url = new URL(config.startUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('startUrl must use HTTPS without embedded credentials.');
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone });
  const periods = [...config.calendar].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < periods.length; i++) {
    if (dateValue(periods[i].start) >= dateValue(periods[i].end)) throw new Error('Calendar periods must end after they start.');
    if (i && periods[i].start < periods[i - 1].end) throw new Error('Calendar periods must not overlap.');
  }
  return config;
}

const configPath = process.argv.includes('--self-test') ? path.join(__dirname, '..', 'config.example.json') : process.env.BB_CONFIG || path.join(__dirname, '..', 'config.local.json');
let configInput;
try { configInput = JSON.parse(readFileSync(configPath, 'utf8')); }
catch (error) {
  if (error.code === 'ENOENT') throw new Error('Copy config.example.json to config.local.json and set your Blackboard URL, or set BB_CONFIG to your configuration file.');
  throw new Error('Could not read Blackboard configuration. Check that it is valid JSON.');
}
const CONFIG = validateConfig(configInput);
const START_URL = CONFIG.startUrl;
const PROFILE = CONFIG.profileDir ? path.resolve(path.dirname(configPath), CONFIG.profileDir) : path.join(os.homedir(), '.blackboard-mcp', new URL(START_URL).hostname, 'edge-profile');
const PIPE = `\\\\.\\pipe\\codex-blackboard-playwright-${createHash('sha256').update(PROFILE.toLowerCase()).digest('hex').slice(0, 16)}`;
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'codex-blackboard-downloads');
const ALLOWED_HOSTS = [new URL(START_URL).hostname, ...CONFIG.allowedHosts.map(host => host.toLowerCase())];
const SIGNED_IN_SELECTOR = CONFIG.signedInSelector || 'a[href*="/ultra/course"], a[href*="/ultra/stream"], a[href*="action=logout"], a[href*="/logout"]';
let context;
let page;
let releaseLock;
let launching;

function allowedUrl(value, hosts = ALLOWED_HOSTS) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

function reply(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function dateValue(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Dates must use YYYY-MM-DD.');
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error('Invalid date.');
  return value;
}

function localDate(now = new Date(), timeZone = CONFIG.timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function academicWeek(date, periods = CONFIG.calendar) {
  const day = dateValue(date);
  const period = periods.find(item => day >= dateValue(item.start) && day < dateValue(item.end));
  let result = { phase: 'No configured academic calendar mapping' };
  if (period) {
    result = { phase: period.phase, ...(period.label ? { label: period.label } : {}) };
    if (period.firstWeek !== undefined) {
      const week = period.firstWeek + Math.floor((day - dateValue(period.start)) / 604800000);
      result = { week, label: `Week ${week}`, phase: period.weekNames[week] || period.phase };
    }
  }
  return { date, ...result, sources: CONFIG.calendarSources, note: 'Calendar entries are user-configured. Confirm course-specific week numbers and schedules in Blackboard.' };
}

function dateContext(now = new Date()) {
  const today = localDate(now);
  const tomorrow = new Date(dateValue(today) + 86400000).toISOString().slice(0, 10);
  return { today: academicWeek(today), tomorrow: academicWeek(tomorrow), timeZone: CONFIG.timeZone };
}

async function acquireLock() {
  const lock = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(PIPE, () => { lock.off('error', reject); resolve(); });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('BUSY: Another Blackboard session owns this Edge profile. Continue there or close its browser before retrying.');
    throw error;
  }
  let closing;
  return () => closing ??= new Promise(resolve => lock.close(() => resolve()));
}

async function edgeUsingProfile() {
  if (process.platform !== 'win32') return false;
  const script = "$p=[Environment]::GetEnvironmentVariable('BB_PROFILE_CHECK'); Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like \"*$p*\" -and $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    env: { ...process.env, BB_PROFILE_CHECK: PROFILE }, timeout: 10000, windowsHide: true,
  });
  return stdout.trim().length > 0;
}

async function ensureBrowser() {
  if (context && page && !page.isClosed()) return page;
  if (launching) return launching;
  launching = (async () => {
    const unlock = await acquireLock();
    try {
      if (await edgeUsingProfile()) throw new Error('BUSY: Edge is already using this Blackboard profile. Close that window before retrying.');
      const ctx = await chromium.launchPersistentContext(PROFILE, {
        channel: 'msedge', headless: false, viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
      });
      context = ctx;
      releaseLock = unlock;
      ctx.setDefaultTimeout(15000);
      ctx.on('page', opened => { page = opened; });
      ctx.once('close', () => {
        if (context === ctx) { context = undefined; page = undefined; releaseLock = undefined; }
        void unlock();
      });
      page = ctx.pages().find(p => !p.isClosed() && p.url() !== 'about:blank') || ctx.pages()[0] || await ctx.newPage();
      return page;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      await unlock();
      throw error;
    }
  })().finally(() => { launching = undefined; });
  return launching;
}

async function snapshot(p, maxChars = 12000) {
  if (p.url() !== 'about:blank') {
    await p.waitForFunction(() => (document.body?.innerText || '').trim().length > 40, null, { timeout: 12000 }).catch(() => {});
  }
  const elements = await p.evaluate(() => {
    document.querySelectorAll('[data-bb-ref]').forEach(el => el.removeAttribute('data-bb-ref'));
    const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true]';
    const found = [];
    for (const el of document.querySelectorAll(selector)) {
      if (found.length >= 150) break;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(el).visibility === 'hidden' || el.disabled) continue;
      const ref = `e${found.length + 1}`;
      el.setAttribute('data-bb-ref', ref);
      found.push({ ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 100) });
    }
    return found;
  });
  const body = await p.locator('body').innerText().catch(() => '');
  return { url: p.url(), title: await p.title().catch(() => ''), calendar: dateContext(), elements, text: body.slice(0, maxChars), truncated: body.length > maxChars };
}

function target(p, args) {
  if (args.ref) {
    if (!/^e\d+$/.test(args.ref)) throw new Error('Use an element reference such as e1 from the latest snapshot.');
    return p.locator(`[data-bb-ref="${args.ref}"]`);
  }
  if (args.role && args.name) return p.getByRole(args.role, { name: args.name, exact: true });
  if (args.selector) return p.locator(args.selector);
  throw new Error('Provide ref, role + name, or selector.');
}

async function loginState(p) {
  const url = p.url();
  const title = await p.title().catch(() => '');
  const text = await p.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  // shortcut: custom themes may need signedInSelector in the local configuration.
  if (allowedUrl(url)) {
    const signedIn = await p.locator(SIGNED_IN_SELECTOR).evaluateAll(elements => elements.some(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    }));
    if (signedIn || (/\bCourses\b/i.test(text) && /\bLog Out\b/i.test(text))) return { status: 'signed_in', url, title };
  }
  const requiresInput = await p.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible').count();
  if ((url !== 'about:blank' && !allowedUrl(url)) || requiresInput) return { status: 'needs_user', url, title, message: 'Complete your institution sign-in or MFA in the open Edge window, then call blackboard_login again.' };
  return { status: 'pending', url, title };
}

async function login() {
  let p = await ensureBrowser();
  if (p.url() === 'about:blank') {
    await p.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  const deadline = Date.now() + 20000;
  let state;
  let clicked = false;
  let signedSince = 0;
  do {
    p = page || p;
    const name = CONFIG.loginButtonName || /^(?:staff and student login|institution(?:al)? login|single sign[- ]on|sso(?: login)?)$/i;
    const button = p.getByRole('link', { name, exact: true }).or(p.getByRole('button', { name, exact: true })).first();
    if (!clicked && await button.isVisible().catch(() => false)) {
      await button.click();
      clicked = true;
      signedSince = 0;
    }
    state = await loginState(p);
    if (state.status === 'signed_in') {
      signedSince ||= Date.now();
      if (Date.now() - signedSince >= 2000) return state;
    } else signedSince = 0;
    await p.waitForTimeout(500);
  } while (Date.now() < deadline);
  return state.status === 'needs_user' ? state : { ...state, message: 'Sign-in is not confirmed yet. The browser remains open; inspect the page or call blackboard_login again.' };
}

async function close() {
  if (context) await context.close();
  else if (releaseLock) await releaseLock();
  context = undefined;
  page = undefined;
  releaseLock = undefined;
}

const server = new McpServer({ name: 'blackboard-playwright', version: '1.1.0' });
function tool(name, description, inputSchema, run) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try { return reply(await run(args)); }
    catch (error) { return reply(error.message, true); }
  });
}
const selectorSchema = { ref: z.string().optional(), role: z.string().optional(), name: z.string().optional(), selector: z.string().optional() };

tool('blackboard_login', 'Open the configured Blackboard site and institution login link. Complete passwords and MFA manually. Returns local dates and any configured academic calendar.', {}, async () => ({ ...await login(), calendar: dateContext() }));
tool('blackboard_academic_week', 'Look up a date in the configured academic calendar, or return today and tomorrow. No week number is inferred without a matching calendar entry.', { date: z.string().optional() }, async ({ date }) => date ? academicWeek(date) : dateContext());
tool('blackboard_snapshot', 'Read the current page text, local calendar and interactive elements. Refresh element references after page changes.', { max_chars: z.number().int().min(200).max(50000).optional() }, async ({ max_chars }) => snapshot(await ensureBrowser(), max_chars));
tool('blackboard_open', 'Open an HTTPS page on the configured Blackboard host or an additional allowed host.', { url: z.string().url() }, async ({ url }) => {
  if (!allowedUrl(url)) throw new Error('Only HTTPS URLs without embedded credentials on configured hosts may be opened directly.');
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return snapshot(p);
});
tool('blackboard_click', 'Click a visible element and return a fresh page snapshot.', selectorSchema, async args => {
  const p = await ensureBrowser();
  await target(p, args).click();
  await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  return snapshot(page || p);
});
tool('blackboard_type', 'Fill a field and optionally press Enter. Users should enter passwords and MFA themselves in the browser.', { ...selectorSchema, value: z.string(), submit: z.boolean().optional() }, async args => {
  const p = await ensureBrowser();
  const locator = target(p, args);
  await locator.fill(args.value);
  if (args.submit) await locator.press('Enter');
  return snapshot(page || p);
});
tool('blackboard_press', 'Send a keyboard key to the current page.', { key: z.string() }, async ({ key }) => {
  const p = await ensureBrowser();
  await p.keyboard.press(key);
  return snapshot(page || p);
});
tool('blackboard_download', 'Click a download control and save the captured file to the system temporary directory.', { ...selectorSchema, expected_filename: z.string().optional() }, async args => {
  const p = await ensureBrowser();
  const [download] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), target(p, args).click()]);
  const filename = download.suggestedFilename();
  if (args.expected_filename && filename !== args.expected_filename) throw new Error(`Expected filename ${args.expected_filename}; received ${filename}. The file was not saved.`);
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const destination = path.join(DOWNLOAD_DIR, `${randomUUID()}-${path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`);
  await download.saveAs(destination);
  return { filename, path: destination };
});
tool('blackboard_tabs', 'List browser tabs, or switch to the supplied one-based tab index.', { index: z.number().int().min(1).optional() }, async ({ index }) => {
  await ensureBrowser();
  const tabs = context.pages().filter(p => !p.isClosed());
  if (index) {
    if (!tabs[index - 1]) throw new Error(`Tab ${index} does not exist.`);
    page = tabs[index - 1];
    await page.bringToFront();
  }
  return Promise.all(tabs.map(async (p, i) => ({ index: i + 1, active: p === page, title: await p.title().catch(() => ''), url: p.url() })));
});
tool('blackboard_screenshot', 'Save a screenshot of the current page when visual inspection is needed.', {}, async () => {
  const p = await ensureBrowser();
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const destination = path.join(DOWNLOAD_DIR, `${randomUUID()}.png`);
  await p.screenshot({ path: destination });
  return { path: destination };
});
tool('blackboard_close', 'Close this browser session and release its profile lock.', {}, async () => { await close(); return 'Blackboard Edge closed. The local sign-in profile was retained.'; });

async function selfTest() {
  assert(allowedUrl(START_URL));
  for (const host of ['learn.example.edu', 'campus.example.org']) {
    const config = validateConfig({ startUrl: `https://${host}/`, allowedHosts: ['portal.example.edu'] });
    const hosts = [new URL(config.startUrl).hostname, ...config.allowedHosts];
    assert(allowedUrl(`https://${host}/ultra/course`, hosts));
    assert(allowedUrl(`https://content.${host}/`, hosts));
    assert(allowedUrl('https://portal.example.edu/timetable', hosts));
    assert(!allowedUrl(`http://${host}/`, hosts));
    assert(!allowedUrl(`https://${host}.evil.example/`, hosts));
    assert(!allowedUrl(`https://user:password@${host}/`, hosts));
    assert(!allowedUrl('https://unrelated.example/', hosts));
  }
  assert.throws(() => validateConfig({ startUrl: 'http://learn.example.edu' }));
  assert.throws(() => validateConfig({ startUrl: 'https://user:password@learn.example.edu' }));
  assert.throws(() => validateConfig({ startUrl: 'https://learn.example.edu', allowedHosts: ['*.example.edu'] }));
  assert.throws(() => validateConfig({ startUrl: 'https://learn.example.edu', timeZone: 'invalid-zone' }));
  const calendar = validateConfig({ startUrl: 'https://learn.example.edu', calendar: [
    { start: '2026-09-07', end: '2026-09-21', firstWeek: 1, weekNames: { 2: 'Reading week' } },
    { start: '2026-09-21', end: '2026-09-28', phase: 'Break' },
    { start: '2026-09-28', end: '2026-10-12', firstWeek: 3 },
  ] }).calendar;
  assert.equal(academicWeek('2026-09-07', calendar).week, 1);
  assert.equal(academicWeek('2026-09-14', calendar).phase, 'Reading week');
  assert.equal(academicWeek('2026-09-21', calendar).week, undefined);
  assert.equal(academicWeek('2026-09-21', calendar).phase, 'Break');
  assert.equal(academicWeek('2026-09-28', calendar).week, 3);
  assert.equal(academicWeek('2026-10-12', calendar).week, undefined);
  assert.equal(academicWeek('2026-09-07', []).week, undefined);
  assert.throws(() => validateConfig({ startUrl: START_URL, calendar: [{ start: '2026-02-30', end: '2026-03-10' }] }));
  assert.throws(() => validateConfig({ startUrl: START_URL, calendar: [{ start: '2026-09-21', end: '2026-09-07' }] }));
  assert.throws(() => validateConfig({ startUrl: START_URL, calendar: [calendar[0], calendar[0]] }));
  assert.equal(localDate(new Date('2026-09-30T23:30:00Z'), 'Europe/London'), '2026-10-01');
  assert.equal(localDate(new Date('2026-09-30T23:30:00Z'), 'America/New_York'), '2026-09-30');
  assert.equal(localDate(new Date('2026-10-25T23:30:00Z'), 'Europe/London'), '2026-10-25');
  assert.throws(() => academicWeek('2026-02-30'));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const fixture = await browser.newPage();
    const origin = new URL(START_URL).origin;
    const fixtures = new Map([
      [origin + '/ultra/course', '<a href="/ultra/course">Courses</a>'],
      [origin + '/webapps/portal/execute/tabs', '<a href="/webapps/login/?action=logout">Sign out</a>'],
      [origin + '/login', '<label>Password<input type="password"></label>'],
      [origin + '/mfa', '<input type="password" hidden><label>Verification code<input autocomplete="one-time-code"></label>'],
      [origin + '/public', '<a hidden href="/ultra/course">Courses</a><a style="visibility:hidden" href="/logout">Log Out</a><p>Public information</p>'],
      ['https://sso.fixture.invalid/auth', '<label>Verification code<input autocomplete="one-time-code"></label>'],
    ]);
    await fixture.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixtures.get(route.request().url()) || 'Fixture not found' }));
    for (const [url, expected] of [
      [origin + '/ultra/course', 'signed_in'],
      [origin + '/webapps/portal/execute/tabs', 'signed_in'],
      [origin + '/login', 'needs_user'],
      [origin + '/mfa', 'needs_user'],
      [origin + '/public', 'pending'],
      ['https://sso.fixture.invalid/auth', 'needs_user'],
      ['about:blank', 'pending'],
    ]) {
      await fixture.goto(url);
      assert.equal((await loginState(fixture)).status, expected, url);
    }
  } finally { await browser.close(); }
  console.log('self-test passed (configuration, host isolation, calendars, time zones, Ultra/classic login and external SSO fixtures)');
}

if (process.argv.includes('--self-test')) {
  selfTest().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close().finally(() => process.exit(0));
  };
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
  process.stdout.once('error', shutdown);
  process.once('SIGINT', shutdown);
  server.connect(new StdioServerTransport()).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
