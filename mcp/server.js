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
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const execFileAsync = promisify(execFile);
const START_URL = 'https://www.ole.bris.ac.uk/ultra/course';
const PROFILE = path.join(os.homedir(), '.codex', 'blackboard-browser', 'edge-profile');
const PIPE = `\\\\.\\pipe\\codex-blackboard-playwright-${createHash('sha256').update(PROFILE.toLowerCase()).digest('hex').slice(0, 16)}`;
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'codex-blackboard-downloads');
const ALLOWED_HOSTS = ['ole.bris.ac.uk', 'bristol.ac.uk', 'bris.ac.uk'];
const CALENDAR_SOURCE = 'https://www.bristol.ac.uk/students/your-studies/academic-year-dates/';
const CALENDAR_POLICY = 'https://www.bristol.ac.uk/media-library/sites/academic-quality/documents/policy/university-academic-calendar-policy.pdf';
const WEEK_NAMES = { 6: '巩固周', 12: '考核准备周', 18: '巩固周', 24: '考核准备周' };
let context;
let page;
let releaseLock;
let launching;

function allowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

function reply(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function dateValue(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期须为 YYYY-MM-DD。');
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error('日期无效。');
  return value;
}

function localDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function academicWeek(date) {
  const day = dateValue(date);
  const inRange = (start, end) => day >= dateValue(start) && day < dateValue(end);
  const numbered = (start, firstWeek) => {
    const week = firstWeek + Math.floor((day - dateValue(start)) / 604800000);
    return { week, label: `Week ${week}`, phase: WEEK_NAMES[week] || '教学周' };
  };
  let result;
  if (inRange('2026-09-14', '2026-09-21')) result = { week: 0, label: 'Week 0', phase: '迎新周' };
  else if (inRange('2026-09-21', '2026-12-14')) result = numbered('2026-09-21', 1);
  else if (inRange('2026-12-14', '2026-12-21')) result = { label: 'MA1', phase: 'TB1 考核周' };
  else if (inRange('2026-12-21', '2027-01-11')) result = { phase: '寒假' };
  else if (inRange('2027-01-11', '2027-01-18')) result = { label: 'P1', phase: 'TB2 准备周' };
  else if (inRange('2027-01-18', '2027-03-22')) result = numbered('2027-01-18', 13);
  else if (inRange('2027-03-22', '2027-04-12')) result = { phase: '春假' };
  else if (inRange('2027-04-12', '2027-05-03')) result = numbered('2027-04-12', 22);
  else if (inRange('2027-05-03', '2027-05-24')) result = { phase: 'TB2 考核期' };
  else result = { phase: '无已核对的学年周次' };
  return { date, ...result, sources: [CALENDAR_SOURCE, CALENDAR_POLICY], note: '学校标准学年周次；具体课程的 Week 编号和上课安排须以该课 Blackboard 页面及课表核对。' };
}

function dateContext(now = new Date()) {
  const today = localDate(now);
  const tomorrow = new Date(dateValue(today) + 86400000).toISOString().slice(0, 10);
  return { today: academicWeek(today), tomorrow: academicWeek(tomorrow), timeZone: 'Europe/London' };
}

async function acquireLock() {
  const lock = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      lock.once('error', reject);
      lock.listen(PIPE, () => { lock.off('error', reject); resolve(); });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('BUSY: 另一 Blackboard Playwright 会话正在使用同一个 Edge 登录资料。请在该会话继续操作，或关闭其浏览器后重试。');
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
      if (await edgeUsingProfile()) throw new Error('BUSY: 现有 Edge 正占用 Blackboard 登录资料。请关闭旧 Blackboard Edge 窗口后重试；不会打开空白窗口。');
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
    if (!/^e\d+$/.test(args.ref)) throw new Error('ref 必须是最新页面快照中的 e1、e2 等编号。');
    return p.locator(`[data-bb-ref="${args.ref}"]`);
  }
  if (args.role && args.name) return p.getByRole(args.role, { name: args.name, exact: true });
  if (args.selector) return p.locator(args.selector);
  throw new Error('请提供 ref、role + name，或 selector。');
}

async function loginState(p) {
  const url = p.url();
  const title = await p.title().catch(() => '');
  const text = await p.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  if (url.startsWith('https://www.ole.bris.ac.uk/ultra/') && /\bCourses\b/i.test(text) && /\bLog Out\b/i.test(text)) return { status: 'signed_in', url, title };
  if (/microsoftonline\.com|microsoft\.com|live\.com/i.test(new URL(url).hostname)) return { status: 'needs_user', url, message: '请在已经打开的 Edge 窗口完成学校账号登录或 MFA，然后再次调用 blackboard_login。' };
  return { status: 'pending', url, title };
}

async function login() {
  let p = await ensureBrowser();
  if (p.url() === 'about:blank' || (!allowedUrl(p.url()) && !/microsoftonline\.com|microsoft\.com|live\.com/i.test(p.url()))) {
    await p.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  const deadline = Date.now() + 20000;
  let state;
  let clicked = false;
  let signedSince = 0;
  do {
    p = page || p;
    const button = p.getByRole('link', { name: /staff and student login/i }).or(p.getByRole('button', { name: /staff and student login/i })).first();
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
  return state.status === 'needs_user' ? state : { ...state, message: '登录跳转尚未完成；浏览器保持打开。稍后再次调用 blackboard_login 查看结果。' };
}

async function close() {
  if (context) await context.close();
  else if (releaseLock) await releaseLock();
  context = undefined;
  page = undefined;
  releaseLock = undefined;
}

const server = new McpServer({ name: 'blackboard-playwright', version: '1.0.0' });
function tool(name, description, inputSchema, run) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try { return reply(await run(args)); }
    catch (error) { return reply(error.message, true); }
  });
}
const selectorSchema = { ref: z.string().optional(), role: z.string().optional(), name: z.string().optional(), selector: z.string().optional() };

tool('blackboard_login', '打开 University of Bristol Blackboard；先点击 Staff and student login，只有需要密码或 MFA 时才请用户接手。返回英国本地日期及学校周次。', {}, async () => ({ ...await login(), calendar: dateContext() }));
tool('blackboard_academic_week', '按英国本地日期查询 Bristol 标准学年周次；课程 Week 编号和具体上课内容仍须查看该课页面及课表。缺省查询今天和明天。', { date: z.string().optional() }, async ({ date }) => date ? academicWeek(date) : dateContext());
tool('blackboard_snapshot', '读取当前 Blackboard 页面文本、英国本地日期、学校周次和可交互元素；页面变化后重新获取 ref。', { max_chars: z.number().int().min(200).max(50000).optional() }, async ({ max_chars }) => snapshot(await ensureBrowser(), max_chars));
tool('blackboard_open', '在当前 Playwright 标签页打开 Bristol 官方网页，包括 Blackboard 和 app.bristol.ac.uk 的个人课表。', { url: z.string().url() }, async ({ url }) => {
  if (!allowedUrl(url)) throw new Error('只允许直接打开 University of Bristol 的 HTTPS 页面。');
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return snapshot(p);
});
tool('blackboard_click', '点击当前页面的可见元素，然后返回页面快照。', selectorSchema, async args => {
  const p = await ensureBrowser();
  await target(p, args).click();
  await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  return snapshot(page || p);
});
tool('blackboard_type', '在当前页面的输入框填入文本；可选按 Enter。', { ...selectorSchema, value: z.string(), submit: z.boolean().optional() }, async args => {
  const p = await ensureBrowser();
  const locator = target(p, args);
  await locator.fill(args.value);
  if (args.submit) await locator.press('Enter');
  return snapshot(page || p);
});
tool('blackboard_press', '向当前页面发送按键。', { key: z.string() }, async ({ key }) => {
  const p = await ensureBrowser();
  await p.keyboard.press(key);
  return snapshot(page || p);
});
tool('blackboard_download', '点击页面上的下载按钮，并将 Playwright 捕获的文件保存到系统临时目录。', { ...selectorSchema, expected_filename: z.string().optional() }, async args => {
  const p = await ensureBrowser();
  const [download] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), target(p, args).click()]);
  const filename = download.suggestedFilename();
  if (args.expected_filename && filename !== args.expected_filename) throw new Error(`下载文件名不符：预期 ${args.expected_filename}，实际 ${filename}。文件未保存。`);
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const destination = path.join(DOWNLOAD_DIR, `${randomUUID()}-${path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`);
  await download.saveAs(destination);
  return { filename, path: destination };
});
tool('blackboard_tabs', '列出 Playwright 标签页；提供 index 时切换到该标签页。', { index: z.number().int().min(1).optional() }, async ({ index }) => {
  await ensureBrowser();
  const tabs = context.pages().filter(p => !p.isClosed());
  if (index) {
    if (!tabs[index - 1]) throw new Error(`没有第 ${index} 个标签页。`);
    page = tabs[index - 1];
    await page.bringToFront();
  }
  return Promise.all(tabs.map(async (p, i) => ({ index: i + 1, active: p === page, title: await p.title().catch(() => ''), url: p.url() })));
});
tool('blackboard_screenshot', '在确需查看视觉内容时截取当前页面。', {}, async () => {
  const p = await ensureBrowser();
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  const destination = path.join(DOWNLOAD_DIR, `${randomUUID()}.png`);
  await p.screenshot({ path: destination });
  return { path: destination };
});
tool('blackboard_close', '关闭本会话控制的 Edge 窗口并释放登录资料。', {}, async () => { await close(); return '已关闭 Blackboard Edge；登录资料已保留。'; });

if (process.argv.includes('--self-test')) {
  assert(allowedUrl(START_URL));
  assert(allowedUrl('https://www.bristol.ac.uk/'));
  assert(allowedUrl('https://app.bristol.ac.uk/'));
  assert(!allowedUrl('http://www.ole.bris.ac.uk/'));
  assert(!allowedUrl('https://ole.bris.ac.uk.evil.example/'));
  assert.equal(academicWeek('2026-09-30').week, 2);
  assert.equal(academicWeek('2026-10-26').phase, '巩固周');
  assert.equal(academicWeek('2027-01-18').week, 13);
  assert.equal(academicWeek('2027-03-22').phase, '春假');
  assert.equal(academicWeek('2027-04-12').week, 22);
  assert.equal(dateContext(new Date('2026-09-30T23:30:00Z')).tomorrow.date, '2026-10-02');
  assert.equal(dateContext(new Date('2026-10-25T23:30:00Z')).tomorrow.week, 6);
  assert.throws(() => academicWeek('2026-02-30'));
  console.log('self-test passed');
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
