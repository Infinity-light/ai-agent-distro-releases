const { chromium } = require('playwright');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const baseUrl = process.env.E2E_BASE_URL || 'https://zhiduoduoai.com';
const expectedRelease = process.env.EXPECTED_RELEASE;
const userToken = process.env.E2E_USER_TOKEN;
const businessDate = process.env.E2E_BUSINESS_DATE;
const dailyAmount = Number(process.env.E2E_DAILY_AMOUNT);
const evidenceDir = path.resolve(process.env.E2E_EVIDENCE_DIR || 'uat-artifacts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function authenticatedContext(browser, viewport) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', deviceScaleFactor: 1 });
  await context.addCookies([{
    name: 'token',
    value: userToken,
    domain: '.zhiduoduoai.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  return context;
}

async function verifyRelease(context, label) {
  const startedAt = Date.now();
  const response = await context.request.get(`${baseUrl}/api/health`);
  const elapsedMs = Date.now() - startedAt;
  assert(response.ok(), `${label}: health returned HTTP ${response.status()}`);
  assert(elapsedMs < 5000, `${label}: health took ${elapsedMs}ms`);
  const body = await response.json();
  const health = body.data || body;
  assert(health.status === 'ok', `${label}: health is not ok`);
  assert(health.release === expectedRelease, `${label}: expected ${expectedRelease}, got ${health.release}`);
  return elapsedMs;
}

function observePage(page) {
  const pageErrors = [];
  const consoleErrors = [];
  const serverErrors = [];
  const failedAssets = [];
  const failedRequests = [];
  const apiRequests = [];

  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
  });
  page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', response => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    if (response.status() >= 400 && /\.(?:js|css|png|svg|woff2?)(?:\?|$)/i.test(response.url())) {
      failedAssets.push(`${response.status()} ${response.url()}`);
    }
  });

  return {
    apiRequests,
    assertClean(label) {
      assert(pageErrors.length === 0, `${label}: page errors: ${pageErrors.join(' | ')}`);
      assert(consoleErrors.length === 0, `${label}: console errors: ${consoleErrors.join(' | ')}`);
      assert(serverErrors.length === 0, `${label}: 5xx responses: ${serverErrors.join(' | ')}`);
      assert(failedAssets.length === 0, `${label}: failed assets: ${failedAssets.join(' | ')}`);
      assert(failedRequests.length === 0, `${label}: failed requests: ${failedRequests.join(' | ')}`);
    },
  };
}

async function firstVisible(locator, label) {
  await locator.first().waitFor({ state: 'attached', timeout: 20_000 });
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) return locator.nth(index);
  }
  throw new Error(`${label} has no visible match`);
}

async function waitForModalAnimations(page) {
  const modal = page.locator('.daily-credits-modal .ant-modal');
  await modal.waitFor({ state: 'visible', timeout: 20_000 });
  await modal.evaluate(async element => {
    const animations = element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running');
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
  });
}

async function openCalendar(page) {
  const entry = await firstVisible(page.locator('.daily-credits-entry'), 'daily credits entry');
  await entry.click();
  await page.locator('#daily-calendar-title').waitFor({ state: 'visible', timeout: 20_000 });
  await waitForModalAnimations(page);
  return entry;
}

async function verifyCrossPageShell(page) {
  const paths = ['/chat', '/generate', '/poster', '/works', '/account'];
  const styles = [];
  for (const route of paths) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 45_000 });
    assert(new URL(page.url()).pathname === route, `${route}: redirected to ${page.url()}`);
    const entry = await firstVisible(page.locator('.daily-credits-entry'), `${route} daily credits entry`);
    const metrics = await entry.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
        minHeight: style.minHeight,
        color: style.color,
      };
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${route}: horizontal overflow`);
    styles.push({ route, ...metrics });
  }
  const baseline = JSON.stringify({ ...styles[0], route: undefined });
  for (const style of styles.slice(1)) {
    assert(JSON.stringify({ ...style, route: undefined }) === baseline, `${style.route}: daily entry shell style drifted`);
  }
  return styles;
}

async function verifyDesktop(browser) {
  const context = await authenticatedContext(browser, { width: 1440, height: 900 });
  const page = await context.newPage();
  const observed = observePage(page);
  try {
    const healthMs = await verifyRelease(context, 'desktop');
    const shellStyles = await verifyCrossPageShell(page);

    const ledgerRequestCount = () => observed.apiRequests.filter(item => item.startsWith('GET /api/token-packs/ledger')).length;
    const claimRequestCount = () => observed.apiRequests.filter(item => item === 'POST /api/token-packs/daily-claim').length;
    let claimKey = '';
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/token-packs/daily-claim') {
        claimKey = request.headers()['x-idempotency-key'] || '';
      }
    });

    assert(new URL(page.url()).pathname === '/account', `desktop: expected /account, got ${page.url()}`);
    const entry = await openCalendar(page);
    const dialog = page.getByRole('dialog');
    assert(await dialog.isVisible(), 'desktop: daily calendar dialog is not visible');
    assert((await page.getByRole('list', { name: /每日积分领取状态/ }).count()) === 1, 'desktop: calendar list semantics missing');
    assert((await page.getByRole('listitem').count()) >= 28, 'desktop: calendar day list is incomplete');

    const today = page.locator(`[data-date="${businessDate}"]`);
    await today.waitFor({ state: 'visible' });
    assert((await today.getAttribute('data-state')) === 'TODAY_CLAIMABLE', `desktop: today state is ${await today.getAttribute('data-state')}`);
    assert((await today.getAttribute('aria-current')) === 'date', 'desktop: today is missing aria-current=date');
    assert((await page.locator('[data-state="MISSED"]').count()) > 0, 'desktop: past missed states are absent');
    const future = page.locator('[data-state="FUTURE"]').first();
    if (await future.count()) {
      assert((await future.locator('.daily-calendar__day-reward').count()) === 0, 'desktop: future date exposes a fabricated reward');
    }

    const toggle = page.locator('.credit-ledger__toggle');
    await toggle.waitFor({ state: 'visible' });
    assert((await toggle.getAttribute('aria-expanded')) === 'false', 'desktop: ledger is not collapsed by default');
    assert((await toggle.getAttribute('aria-controls')) === 'credit-ledger-details', 'desktop: ledger toggle lacks aria-controls');
    assert((await page.locator('#credit-ledger-details').count()) === 0, 'desktop: collapsed ledger details exist in DOM');
    assert(ledgerRequestCount() === 0, `desktop: collapsed ledger preloaded ${ledgerRequestCount()} request(s)`);
    await page.locator('.credit-ledger__balance strong').waitFor({ state: 'visible' });
    assert((await page.locator('.credit-ledger__balance strong').textContent()).trim() === '0', 'desktop: initial balance is not transparently shown as 0');
    assert((await page.locator('.credit-ledger__summary').textContent()).includes('明细默认收起，按需查看'), 'desktop: collapsed-state explanation missing');
    assert((await page.locator('.daily-calendar__stats > div').first().locator('strong').textContent()).trim() === '0', 'desktop: fresh streak is not zero');

    await page.screenshot({ path: path.join(evidenceDir, 'production-desktop-calendar-before-claim.png'), fullPage: true });

    const claimButton = page.locator('.daily-calendar__claim-button');
    const claimResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/token-packs/daily-claim');
    await claimButton.evaluate(element => {
      element.click();
      element.click();
    });
    const claimResponse = await claimResponsePromise;
    assert(claimResponse.ok(), `desktop: first claim returned ${claimResponse.status()}`);
    const claimBody = await claimResponse.json();
    const firstClaim = claimBody.data || claimBody;
    assert(firstClaim.claimed && firstClaim.grant?.amount === dailyAmount, 'desktop: first claim did not credit the configured amount');
    await page.waitForFunction(date => document.querySelector(`[data-date="${date}"]`)?.getAttribute('data-state') === 'TODAY_CLAIMED', businessDate);
    assert(claimRequestCount() === 1, `desktop: double click submitted ${claimRequestCount()} claims`);
    assert(claimKey.length >= 16, 'desktop: claim did not send an idempotency key');
    assert(await claimButton.isDisabled(), 'desktop: claim button stayed enabled after success');
    assert((await page.locator('.daily-calendar__announcement').textContent()).includes('连续领取 1 天'), 'desktop: success feedback/streak did not update immediately');
    assert((await page.locator('.daily-calendar__stats > div').first().locator('strong').textContent()).trim() === '1', 'desktop: streak did not update to one');
    await page.waitForFunction(amount => document.querySelector('.credit-ledger__balance strong')?.textContent?.replace(/,/g, '').trim() === String(amount), dailyAmount);

    const replay = await context.request.post(`${baseUrl}/api/token-packs/daily-claim`, {
      headers: { 'x-idempotency-key': claimKey },
      data: {},
    });
    const replayBody = await replay.json();
    const replayData = replayBody.data || replayBody;
    assert(replay.ok() && replayData.idempotentReplay === true, `desktop: same-key replay returned ${replay.status()}`);
    assert(replayData.grant?.id === firstClaim.grant.id, 'desktop: same-key replay returned a different grant');

    const duplicate = await context.request.post(`${baseUrl}/api/token-packs/daily-claim`, {
      headers: { 'x-idempotency-key': `production-duplicate-${randomUUID()}` },
      data: {},
    });
    assert(duplicate.status() === 409, `desktop: different-key duplicate returned ${duplicate.status()}, expected 409`);

    await toggle.focus();
    assert(await toggle.evaluate(element => document.activeElement === element), 'desktop: ledger toggle cannot receive focus');
    await page.keyboard.press('Enter');
    await page.locator('#credit-ledger-details').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.credit-ledger__item').length >= 4);
    assert((await toggle.getAttribute('aria-expanded')) === 'true', 'desktop: keyboard did not expand ledger');
    assert(ledgerRequestCount() === 1, `desktop: first expansion made ${ledgerRequestCount()} ledger requests`);
    for (const type of ['EARN', 'SPEND', 'RESERVE', 'REFUND']) {
      assert((await page.locator(`[data-ledger-type="${type}"]`).count()) > 0, `desktop: ${type} category is missing`);
    }
    const ledgerText = await page.locator('#credit-ledger-details').textContent();
    assert(ledgerText.includes('北京时间'), 'desktop: ledger time zone label is missing');
    assert(!/(provider|requestId|allocation|unitCost|userId|tokenPackId)/i.test(ledgerText), 'desktop: sensitive internal ledger fields leaked');

    const more = page.getByRole('button', { name: '加载更多流水' });
    await more.waitFor({ state: 'visible' });
    const firstPageCount = await page.locator('.credit-ledger__item').count();
    await more.click();
    await page.waitForFunction(previous => document.querySelectorAll('.credit-ledger__item').length > previous, firstPageCount);
    assert(ledgerRequestCount() === 2, `desktop: load more made ${ledgerRequestCount()} total ledger requests`);
    assert((await page.locator('.credit-ledger__item').count()) > 10, 'desktop: load more did not append a second page');
    await page.locator('#credit-ledger-details').scrollIntoViewIfNeeded();
    await page.locator('#credit-ledger-details').screenshot({ path: path.join(evidenceDir, 'production-desktop-ledger-expanded.png') });

    await toggle.click();
    assert((await toggle.getAttribute('aria-expanded')) === 'false', 'desktop: ledger did not collapse');
    assert((await page.locator('#credit-ledger-details').count()) === 0, 'desktop: collapsed ledger details remain in DOM');
    assert(await toggle.evaluate(element => document.activeElement === element), 'desktop: collapse lost toggle focus');
    const requestsBeforeRefresh = ledgerRequestCount();

    await page.locator('.ant-modal-close').click();
    await dialog.waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
    const refreshedEntry = await firstVisible(page.locator('.daily-credits-entry'), 'refreshed daily credits entry');
    assert((await refreshedEntry.getAttribute('aria-label')).includes('今日已领取'), 'desktop: refreshed entry did not recover claimed state');
    await openCalendar(page);
    await page.waitForFunction(date => document.querySelector(`[data-date="${date}"]`)?.getAttribute('data-state') === 'TODAY_CLAIMED', businessDate);
    assert((await page.locator('#credit-ledger-details').count()) === 0, 'desktop: refresh reopened ledger details');
    assert(ledgerRequestCount() === requestsBeforeRefresh, 'desktop: refresh/open preloaded ledger while collapsed');
    assert((await page.locator('.credit-ledger__balance strong').textContent()).replace(/,/g, '').trim() === String(dailyAmount), 'desktop: refresh lost claimed balance');
    await page.screenshot({ path: path.join(evidenceDir, 'production-desktop-calendar-after-refresh.png'), fullPage: true });

    observed.assertClean('desktop');
    return {
      viewport: '1440x900',
      healthMs,
      shellPages: shellStyles.map(item => item.route),
      businessDate,
      initialState: 'TODAY_CLAIMABLE',
      finalState: 'TODAY_CLAIMED',
      firstClaimStatus: claimResponse.status(),
      sameKeyReplayStatus: replay.status(),
      differentKeyDuplicateStatus: duplicate.status(),
      balanceAfterClaim: dailyAmount,
      ledgerRequests: ledgerRequestCount(),
      ledgerTypes: ['EARN', 'SPEND', 'RESERVE', 'REFUND'],
      refreshed: true,
    };
  } finally {
    await context.close();
  }
}

async function verifyMobile(browser) {
  const context = await authenticatedContext(browser, { width: 375, height: 812 });
  const page = await context.newPage();
  const observed = observePage(page);
  try {
    const healthMs = await verifyRelease(context, 'mobile');
    await page.goto(`${baseUrl}/account`, { waitUntil: 'networkidle', timeout: 45_000 });
    assert(new URL(page.url()).pathname === '/account', `mobile: redirected to ${page.url()}`);
    const entry = await firstVisible(page.locator('.daily-credits-entry'), 'mobile daily credits entry');
    const entryBox = await entry.boundingBox();
    assert(entryBox && entryBox.height >= 44, `mobile: entry touch target is ${entryBox?.height}px`);
    await entry.click();
    await page.locator('#daily-calendar-title').waitFor({ state: 'visible', timeout: 20_000 });
    await waitForModalAnimations(page);

    const modal = page.locator('.daily-credits-modal .ant-modal');
    const modalBox = await modal.boundingBox();
    assert(modalBox && modalBox.x >= -1 && modalBox.x + modalBox.width <= 376, `mobile: modal overflows viewport (${JSON.stringify(modalBox)})`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'mobile: document has horizontal overflow');
    assert(await page.locator('.daily-credits-modal .ant-modal-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'mobile: modal content has horizontal overflow');

    const today = page.locator(`[data-date="${businessDate}"]`);
    assert((await today.getAttribute('data-state')) === 'TODAY_CLAIMED', 'mobile: claimed state is not visible');
    const claimButton = page.locator('.daily-calendar__claim-button');
    const toggle = page.locator('.credit-ledger__toggle');
    for (const [label, control] of [['claim', claimButton], ['ledger toggle', toggle]]) {
      const box = await control.boundingBox();
      assert(box && box.height >= 44, `mobile: ${label} touch target is ${box?.height}px`);
    }
    assert(await claimButton.isDisabled(), 'mobile: claimed button is enabled');
    assert((await toggle.getAttribute('aria-expanded')) === 'false', 'mobile: ledger is not collapsed by default');
    assert((await page.locator('#credit-ledger-details').count()) === 0, 'mobile: collapsed ledger details exist in DOM');
    assert(!observed.apiRequests.some(item => item.startsWith('GET /api/token-packs/ledger')), 'mobile: collapsed ledger preloaded data');
    await page.screenshot({ path: path.join(evidenceDir, 'production-mobile-calendar.png') });

    await toggle.focus();
    await page.keyboard.press('Space');
    await page.locator('#credit-ledger-details').waitFor({ state: 'visible' });
    await page.waitForFunction(() => ['EARN', 'SPEND', 'RESERVE', 'REFUND'].every(type =>
      document.querySelector(`[data-ledger-type="${type}"]`),
    ));
    assert((await toggle.getAttribute('aria-expanded')) === 'true', 'mobile: Space did not expand ledger');
    assert(observed.apiRequests.filter(item => item.startsWith('GET /api/token-packs/ledger')).length === 1, 'mobile: first expansion did not make exactly one ledger request');
    assert((await page.locator('[data-ledger-type="EARN"]').count()) > 0, 'mobile: earned entry missing');
    assert((await page.locator('[data-ledger-type="REFUND"]').count()) > 0, 'mobile: refund entry missing');
    await page.locator('#credit-ledger-details').scrollIntoViewIfNeeded();
    await page.locator('#credit-ledger-details').screenshot({ path: path.join(evidenceDir, 'production-mobile-ledger-expanded.png') });

    await toggle.click();
    assert((await page.locator('#credit-ledger-details').count()) === 0, 'mobile: second toggle did not collapse ledger');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert(await entry.evaluate(element => document.activeElement === element), 'mobile: closing dialog did not restore focus to entry');

    observed.assertClean('mobile');
    return {
      viewport: '375x812',
      healthMs,
      horizontalOverflow: false,
      entryTouchTarget: entryBox.height,
      calendarState: 'TODAY_CLAIMED',
      keyboardExpanded: true,
      focusRestored: true,
      ledgerCollapsedAgain: true,
    };
  } finally {
    await context.close();
  }
}

(async () => {
  assert(expectedRelease && /^[0-9a-f]{40}$/.test(expectedRelease), 'EXPECTED_RELEASE must be a full SHA');
  assert(userToken, 'E2E_USER_TOKEN is required');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(businessDate || ''), 'E2E_BUSINESS_DATE is invalid');
  assert(Number.isInteger(dailyAmount) && dailyAmount > 0, 'E2E_DAILY_AMOUNT is invalid');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await verifyDesktop(browser);
    const mobile = await verifyMobile(browser);
    const report = {
      release: expectedRelease,
      productionUrl: baseUrl,
      testedAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai',
      desktop,
      mobile,
      sensitiveLedgerFieldsExposed: false,
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
