const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const baseUrl = process.env.E2E_BASE_URL || 'https://zhiduoduoai.com';
const expectedRelease = process.env.EXPECTED_RELEASE;
const authToken = process.env.E2E_TOKEN;
const evidenceDir = path.resolve(process.env.E2E_EVIDENCE_DIR || 'uat-artifacts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function roundedRect(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return Object.fromEntries(
    ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']
      .map(key => [key, Math.round(rect[key])]),
  );
}

async function openAuthenticatedContext(browser, viewport) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', deviceScaleFactor: 1 });
  await context.addCookies([{
    name: 'token',
    value: authToken,
    domain: '.zhiduoduoai.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  return context;
}

async function verifyRelease(context, label) {
  const response = await context.request.get(`${baseUrl}/api/health`);
  assert(response.ok(), `${label}: health returned HTTP ${response.status()}`);
  const body = await response.json();
  const health = body.data || body;
  assert(health.status === 'ok', `${label}: health status is not ok`);
  assert(health.release === expectedRelease, `${label}: expected release ${expectedRelease}, got ${health.release}`);
}

async function loadChat(page, label) {
  const pageErrors = [];
  const serverErrors = [];
  const failedAssets = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    if (response.status() >= 400 && /\.(?:js|css|png|svg)(?:\?|$)/.test(response.url())) {
      failedAssets.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(`${baseUrl}/chat`, { waitUntil: 'networkidle', timeout: 45_000 });
  await page.getByText('智多多 AI 助手', { exact: true }).waitFor({ timeout: 20_000 });
  assert(new URL(page.url()).pathname === '/chat', `${label}: redirected away from authenticated chat to ${page.url()}`);
  assert(pageErrors.length === 0, `${label}: page errors: ${pageErrors.join(' | ')}`);
  assert(serverErrors.length === 0, `${label}: 5xx responses: ${serverErrors.join(' | ')}`);
  assert(failedAssets.length === 0, `${label}: failed assets: ${failedAssets.join(' | ')}`);
}

async function pageMetrics(page) {
  return page.evaluate(() => {
    const rect = element => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return Object.fromEntries(
        ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left']
          .map(key => [key, Math.round(value[key])]),
      );
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      topbar: rect(document.querySelector('[data-testid="app-header"]')),
      sidebar: rect(document.querySelector('[data-testid="app-sidebar"]')),
      bottomNav: rect(document.querySelector('[data-testid="mobile-bottom-nav"]')),
      brandLogoCount: document.querySelectorAll('[data-testid="brand-logo"]').length,
      brandLogoSource: document.querySelector('[data-testid="app-header"] img[alt="智多多品牌 Logo"]')?.getAttribute('src') || null,
      brandLogoWidth: Math.round(document.querySelector('[data-testid="app-header"] img[alt="智多多品牌 Logo"]')?.getBoundingClientRect().width || 0),
      assistantMascotCount: document.querySelectorAll('[data-testid="assistant-mascot"]').length,
      assistantMascotSource: document.querySelector('[data-testid="assistant-mascot"] img')?.getAttribute('src') || null,
      assistantMascotSize: rect(document.querySelector('[data-testid="assistant-mascot"]')),
      messageMascotCount: document.querySelectorAll('.msg-ai [data-testid="assistant-mascot"]').length,
      welcomeMessageCount: document.querySelectorAll('[aria-label="智多多 AI 助手欢迎消息"]').length,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

async function assertSeparatedBrandIdentities(page, label) {
  const logo = page.locator('[data-testid="app-header"] img[alt="智多多品牌 Logo"]');
  const mascot = page.locator('[data-testid="chat-assistant-identity"] [data-testid="assistant-mascot"]');
  assert(await logo.count() === 1, `${label}: expected one corporate brand logo in the header, got ${await logo.count()}`);
  const loaded = await logo.evaluate(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  assert(loaded, `${label}: corporate brand logo did not load`);
  const logoSource = await logo.getAttribute('src');
  assert(logoSource?.includes('/assets/brand/zhiduoduo-brand-lockup-light-'), `${label}: unexpected brand logo source ${logoSource}`);

  assert(await mascot.count() === 1, `${label}: expected one Chat assistant mascot, got ${await mascot.count()}`);
  const mascotImage = mascot.locator('img');
  const mascotLoaded = await mascotImage.evaluate(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  assert(mascotLoaded, `${label}: Chat assistant mascot did not load`);
  const mascotSource = await mascotImage.getAttribute('src');
  assert(mascotSource === '/assets/zhiduoduo-assistant-v1.png', `${label}: unexpected mascot source ${mascotSource}`);
  assert(logoSource !== mascotSource, `${label}: corporate brand and Chat mascot use the same asset`);
  assert(await page.locator('[data-testid="app-header"] img[src*="zhiduoduo-assistant-v1.png"]').count() === 0, `${label}: mascot leaked into global header`);
}

async function verifyDesktop(browser) {
  const label = 'desktop-1440x900';
  const context = await openAuthenticatedContext(browser, { width: 1440, height: 900 });
  const page = await context.newPage();
  try {
    await verifyRelease(context, label);
    await loadChat(page, label);
    await assertSeparatedBrandIdentities(page, label);
    const metrics = await pageMetrics(page);
    assert(JSON.stringify(metrics.topbar) === JSON.stringify({ x: 0, y: 0, width: 1440, height: 64, top: 0, right: 1440, bottom: 64, left: 0 }), `${label}: invalid topbar ${JSON.stringify(metrics.topbar)}`);
    assert(JSON.stringify(metrics.sidebar) === JSON.stringify({ x: 0, y: 64, width: 220, height: 836, top: 64, right: 220, bottom: 900, left: 0 }), `${label}: invalid sidebar ${JSON.stringify(metrics.sidebar)}`);
    assert(metrics.brandLogoCount === 1, `${label}: expected one brand lockup, got ${metrics.brandLogoCount}`);
    assert(metrics.brandLogoWidth === 132, `${label}: expected 132px header logo, got ${metrics.brandLogoWidth}`);
    assert(metrics.assistantMascotCount === 1, `${label}: expected one assistant mascot, got ${metrics.assistantMascotCount}`);
    assert(metrics.assistantMascotSize?.width === 42 && metrics.assistantMascotSize?.height === 42, `${label}: invalid assistant mascot size ${JSON.stringify(metrics.assistantMascotSize)}`);
    assert(metrics.messageMascotCount === 0, `${label}: repeated assistant mascots remain in messages (${metrics.messageMascotCount})`);
    assert(metrics.welcomeMessageCount === 1, `${label}: welcome message role marker missing`);
    assert(metrics.horizontalOverflow === 0, `${label}: horizontal overflow ${metrics.horizontalOverflow}px`);
    await page.screenshot({ path: path.join(evidenceDir, `${label}.png`), fullPage: true });

    await page.locator('.page-enter').evaluate(element => { element.style.minHeight = '1800px'; });
    await page.evaluate(() => window.scrollTo(0, 800));
    const scrollAnchors = await page.evaluate(() => ({
      topbarY: Math.round(document.querySelector('[data-testid="app-header"]')?.getBoundingClientRect().y ?? -1),
      sidebarY: Math.round(document.querySelector('[data-testid="app-sidebar"]')?.getBoundingClientRect().y ?? -1),
    }));
    assert(scrollAnchors.topbarY === 0 && scrollAnchors.sidebarY === 64, `${label}: fixed shell shifted on scroll ${JSON.stringify(scrollAnchors)}`);
    return { ...metrics, scrollAnchors };
  } finally {
    await context.close();
  }
}

async function verifyMobile(browser) {
  const label = 'mobile-390x844';
  const context = await openAuthenticatedContext(browser, { width: 390, height: 844 });
  const page = await context.newPage();
  try {
    await verifyRelease(context, label);
    await loadChat(page, label);
    await assertSeparatedBrandIdentities(page, label);
    const metrics = await pageMetrics(page);
    assert(JSON.stringify(metrics.topbar) === JSON.stringify({ x: 0, y: 0, width: 390, height: 56, top: 0, right: 390, bottom: 56, left: 0 }), `${label}: invalid topbar ${JSON.stringify(metrics.topbar)}`);
    assert(metrics.sidebar === null, `${label}: fixed desktop sidebar is still present`);
    assert(metrics.bottomNav && metrics.bottomNav.x === 0 && metrics.bottomNav.right === 390 && metrics.bottomNav.bottom === 844, `${label}: invalid bottom navigation ${JSON.stringify(metrics.bottomNav)}`);
    assert(metrics.brandLogoCount === 1, `${label}: expected one brand lockup, got ${metrics.brandLogoCount}`);
    assert(metrics.brandLogoWidth === 108, `${label}: expected 108px header logo, got ${metrics.brandLogoWidth}`);
    assert(metrics.assistantMascotCount === 1, `${label}: expected one assistant mascot, got ${metrics.assistantMascotCount}`);
    assert(metrics.assistantMascotSize?.width === 34 && metrics.assistantMascotSize?.height === 34, `${label}: invalid assistant mascot size ${JSON.stringify(metrics.assistantMascotSize)}`);
    assert(metrics.messageMascotCount === 0, `${label}: repeated assistant mascots remain in messages (${metrics.messageMascotCount})`);
    assert(metrics.welcomeMessageCount === 1, `${label}: welcome message role marker missing`);
    assert(metrics.horizontalOverflow === 0, `${label}: horizontal overflow ${metrics.horizontalOverflow}px`);
    await page.screenshot({ path: path.join(evidenceDir, `${label}.png`), fullPage: true });

    await page.getByRole('button', { name: '打开导航菜单' }).click();
    const drawer = page.locator('.ant-drawer-content-wrapper');
    await drawer.waitFor({ state: 'visible' });
    await page.waitForFunction(() => Math.round(document.querySelector('.ant-drawer-content-wrapper')?.getBoundingClientRect().x ?? -1) === 0);
    const drawerRect = await drawer.evaluate(roundedRect);
    assert(drawerRect.x === 0 && drawerRect.y === 0 && drawerRect.width === 260 && drawerRect.height === 844, `${label}: invalid drawer ${JSON.stringify(drawerRect)}`);
    const drawerLogo = drawer.locator('img[alt="智多多品牌 Logo"]');
    assert(await drawerLogo.count() === 1, `${label}: drawer brand logo missing`);
    assert((await drawerLogo.getAttribute('src'))?.includes('/assets/brand/zhiduoduo-brand-lockup-light-'), `${label}: drawer uses unexpected brand asset`);
    await page.screenshot({ path: path.join(evidenceDir, `${label}-drawer.png`), fullPage: true });
    return { ...metrics, drawer: drawerRect };
  } finally {
    await context.close();
  }
}

(async () => {
  assert(expectedRelease && /^[0-9a-f]{40}$/.test(expectedRelease), 'EXPECTED_RELEASE must be a full commit SHA');
  assert(authToken, 'E2E_TOKEN is required');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await verifyDesktop(browser);
    const mobile = await verifyMobile(browser);
    const report = {
      url: `${baseUrl}/chat`,
      release: expectedRelease,
      testedAt: new Date().toISOString(),
      desktop,
      mobile,
    };
    fs.writeFileSync(path.join(evidenceDir, 'production-uat.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
