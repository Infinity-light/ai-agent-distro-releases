const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const baseUrl = process.env.E2E_BASE_URL || 'https://zhiduoduoai.com';
const expectedRelease = process.env.EXPECTED_RELEASE;
const authToken = process.env.E2E_TOKEN;
const runId = process.env.GITHUB_RUN_ID || String(Date.now());
const evidenceDir = path.resolve(process.env.E2E_EVIDENCE_DIR || 'uat-artifacts');
const forbiddenWaitingText = /实际进度|上游|provider|upstream|confidence|置信度|按当前任务/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unwrap(body) {
  return body && body.code === 0 && Object.hasOwn(body, 'data') ? body.data : body;
}

async function json(response, label, allowFailure = false) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`${label} returned non-JSON HTTP ${response.status()}: ${text.slice(0, 300)}`); }
  if (!allowFailure && !response.ok()) throw new Error(`${label} returned HTTP ${response.status()}: ${JSON.stringify(body).slice(0, 600)}`);
  return body;
}

async function balance(context) {
  const response = await context.request.get(`${baseUrl}/api/token-packs/balance`);
  const data = unwrap(await json(response, 'credit balance'));
  const remaining = Number(data.remaining ?? data.balance);
  assert(Number.isFinite(remaining), `Credit balance is not numeric: ${JSON.stringify(data)}`);
  return { remaining, paidRemaining: Number(data.paidRemaining ?? remaining), raw: data };
}

async function status(context, generationId) {
  const response = await context.request.get(`${baseUrl}/api/ai/generate/video/status/${generationId}`);
  return unwrap(await json(response, `video status ${generationId}`));
}

function safeVideoReference(value) {
  if (!value) return null;
  const url = new URL(value, baseUrl);
  return `${url.origin}${url.pathname}`;
}

(async () => {
  assert(/^[0-9a-f]{40}$/.test(expectedRelease || ''), 'EXPECTED_RELEASE is missing or invalid');
  assert(authToken, 'E2E_TOKEN is missing');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await context.addCookies([{
    name: 'token', value: authToken, domain: '.zhiduoduoai.com', path: '/',
    httpOnly: true, secure: true, sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const unexpectedServerErrors = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    const expectedProviderRejection = pathname === '/api/ai/generate/video' && response.request().method() === 'POST';
    if (response.status() >= 500 && !expectedProviderRejection) unexpectedServerErrors.push(`${response.status()} ${pathname}`);
  });

  let failedGenerationId = '';
  let completedGenerationId = '';
  try {
    const healthResponse = await context.request.get(`${baseUrl}/api/health`);
    const health = unwrap(await json(healthResponse, 'production health'));
    assert(health.status === 'ok', `Production health is ${health.status}`);
    assert(health.release === expectedRelease, `Expected release ${expectedRelease}, got ${health.release}`);

    const before = await balance(context);
    await page.goto(`${baseUrl}/video`, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.getByText('AI 视频 · 管理员灰度', { exact: true }).waitFor({ timeout: 20_000 });
    assert(new URL(page.url()).pathname === '/video', `Admin account was redirected to ${page.url()}`);

    // First exercise a real provider rejection through the production UI. The
    // value is schema-valid but deliberately absent from the account's Ark
    // authorized asset library, so the request reaches Ark and cannot create
    // an upstream video task.
    const unauthorizedAssetId = `asset-uat-not-authorized-${runId}`.slice(0, 100);
    await page.getByLabel('导演提示词').fill('生产事故恢复验收：授权素材校验，不应创建视频，也不应扣积分。');
    await page.getByPlaceholder('asset-2026…').fill(unauthorizedAssetId);
    await page.getByRole('button', { name: '添加授权素材' }).click();
    const failureResponsePromise = page.waitForResponse(response => {
      const request = response.request();
      return new URL(response.url()).pathname === '/api/ai/generate/video' && request.method() === 'POST';
    }, { timeout: 60_000 });
    await page.getByRole('button', { name: /提交管理员灰度任务/ }).click();
    const failureResponse = await failureResponsePromise;
    const failureBody = await json(failureResponse, 'expected provider rejection', true);
    assert(!failureResponse.ok(), `Unauthorized Ark asset unexpectedly returned HTTP ${failureResponse.status()}`);
    assert(failureBody.code === 'VIDEO_PROVIDER_REJECTED', `Unexpected rejection code: ${JSON.stringify(failureBody)}`);
    assert(failureBody.generationId, 'Provider rejection did not retain a generation ID');
    assert(failureBody.requestId, 'Provider rejection did not return the inbound request ID');
    assert(failureBody.providerClientRequestId, 'Provider rejection did not return the outbound request ID');
    failedGenerationId = failureBody.generationId;
    fs.appendFileSync(process.env.GITHUB_ENV, `UAT_FAILED_GENERATION_ID=${failedGenerationId}\n`);
    await page.getByText('视频任务未能开始', { exact: true }).waitFor({ timeout: 20_000 });
    const failedStatus = await status(context, failedGenerationId);
    assert(failedStatus.status === 'FAILED', `Rejected generation is ${failedStatus.status}, expected FAILED`);
    assert(!failedStatus.metadata?.providerTaskId && !failedStatus.providerTaskId, 'Rejected generation retained an upstream provider task');
    await page.screenshot({ path: path.join(evidenceDir, '01-provider-rejection-zero-charge.png'), fullPage: true });
    const afterFailure = await balance(context);
    assert(afterFailure.remaining === before.remaining, `Rejected request changed balance ${before.remaining} -> ${afterFailure.remaining}`);

    // Start a fresh text-only 4-second task through the same production UI.
    await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
    await page.getByLabel('导演提示词').fill([
      '4秒竖屏咖啡产品短片，无人物、无文字、无商标。',
      '0–1秒：微距拍摄咖啡豆落入白色陶瓷杯旁，静物建立。',
      '1–2秒：一束晨光从左向右扫过杯沿，轻微推进。',
      '2–3秒：咖啡液形成细腻涟漪，俯拍转为45度近景。',
      '3–4秒：镜头停在完整杯身与暖色桌面，干净收尾。',
    ].join('\n'));
    const slider = page.getByRole('slider');
    await slider.press('Home');
    assert(await slider.getAttribute('aria-valuenow') === '4', 'Duration slider did not select 4 seconds');
    const successResponsePromise = page.waitForResponse(response => {
      const request = response.request();
      return new URL(response.url()).pathname === '/api/ai/generate/video' && request.method() === 'POST';
    }, { timeout: 60_000 });
    await page.getByRole('button', { name: /提交管理员灰度任务/ }).click();
    const successResponse = await successResponsePromise;
    const successBody = unwrap(await json(successResponse, 'short video submission'));
    assert(successResponse.status() === 201, `Short video submission returned ${successResponse.status()}`);
    assert(successBody.id, 'Short video submission did not return a generation ID');
    assert(successBody.creditCost === 400, `Expected 400 credits, got ${successBody.creditCost}`);
    completedGenerationId = successBody.id;
    fs.appendFileSync(process.env.GITHUB_ENV, `UAT_COMPLETED_GENERATION_ID=${completedGenerationId}\n`);
    const submissionRequestId = successResponse.headers()['x-request-id'];
    assert(submissionRequestId, 'Successful submission response lacks X-Request-Id');

    const progressComponent = page.locator('.video-job-progress');
    await progressComponent.waitFor({ timeout: 20_000 });
    const progressbar = page.getByRole('progressbar', { name: '视频生成进度' });
    assert(await progressbar.count() === 1, 'Waiting UI must expose exactly one progressbar');
    assert(await progressbar.getAttribute('aria-valuenow') === '0', 'New short video must start from persisted 0 percent');
    assert(await progressbar.getAttribute('aria-valuetext') === '0/1 个片段已完成', 'Progressbar ARIA text is not event-backed');
    const waitingText = await progressComponent.innerText();
    assert(waitingText.includes('正在生成视频') && waitingText.includes('0/1'), `Unexpected waiting headline: ${waitingText}`);
    assert(!forbiddenWaitingText.test(waitingText), `Waiting UI leaked internal wording: ${waitingText}`);
    assert(await page.getByText(/预计还需/).count() === 0, 'ETA should be hidden without stable samples');
    await page.getByText('查看进度详情').click();
    await page.getByText('已耗时', { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByText('当前步骤', { exact: true }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: path.join(evidenceDir, '02-provider-backed-progress.png'), fullPage: true });

    const snapshots = [];
    let current = await status(context, completedGenerationId);
    snapshots.push(current);
    assert(current.stage?.code && current.stage?.label, 'Pending task has no backend stage');
    assert(current.progress && Number.isFinite(current.progress.totalUnits), 'Pending task has no backend progress');
    assert(current.timing && Number.isFinite(current.timing.elapsedSeconds), 'Pending task has no backend elapsed time');
    assert(current.progress.percent === 0 && current.progress.state !== 'succeeded', 'Pending task reported false completion');
    assert(current.timing.eta === null, 'One-sample task should not expose an ETA');

    await page.reload({ waitUntil: 'networkidle', timeout: 45_000 });
    const restored = await status(context, completedGenerationId);
    assert(restored.progress.completedUnits >= current.progress.completedUnits, 'Refresh regressed persisted progress');
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(restored.status)) {
      const restoredProgress = page.locator('.video-job-progress');
      await restoredProgress.waitFor({ timeout: 20_000 });
      const restoredText = await restoredProgress.innerText();
      assert(restoredText.includes(`${restored.progress.completedUnits}/${restored.progress.totalUnits}`), 'Refresh did not restore the persisted count');
      assert(!forbiddenWaitingText.test(restoredText), 'Refresh restored internal waiting text');
      await page.setViewportSize({ width: 375, height: 812 });
      const box = await restoredProgress.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      assert(box.scrollWidth <= box.clientWidth, `Mobile progress overflow ${box.scrollWidth} > ${box.clientWidth}`);
      await page.screenshot({ path: path.join(evidenceDir, '02b-provider-progress-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }

    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) {
      const resumeButton = page.getByRole('button', { name: '刷新并恢复' });
      if (await resumeButton.isVisible()) await resumeButton.click();
    }

    const deadline = Date.now() + 22 * 60_000;
    while (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      current = await status(context, completedGenerationId);
      snapshots.push(current);
    }
    assert(current.status === 'COMPLETED', `Short video ended as ${current.status || 'timeout'}: ${current.errorMessage || ''}`);
    assert(current.videoUrl, 'Completed short video has no video URL');
    assert(current.stage?.code === 'succeeded', `Completed task stage is ${current.stage?.code}`);
    assert(current.progress?.completedUnits === current.progress?.totalUnits, 'Completed task progress is not terminal');
    const resolvedVideoUrl = new URL(current.videoUrl, baseUrl).toString();
    const videoResponse = await context.request.get(resolvedVideoUrl, { timeout: 60_000 });
    assert(videoResponse.ok(), `Completed video URL returned HTTP ${videoResponse.status()}`);
    await page.locator('video').waitFor({ timeout: 45_000 });
    await page.screenshot({ path: path.join(evidenceDir, '03-completed-short-video.png'), fullPage: true });

    const afterSuccess = await balance(context);
    assert(afterSuccess.remaining === before.remaining - 400, `Completed task balance expected ${before.remaining - 400}, got ${afterSuccess.remaining}`);
    assert(pageErrors.length === 0, `Production page errors: ${pageErrors.join(' | ')}`);
    assert(consoleErrors.length === 0, `Production console errors: ${consoleErrors.join(' | ')}`);
    assert(unexpectedServerErrors.length === 0, `Unexpected production 5xx responses: ${unexpectedServerErrors.join(' | ')}`);

    const evidence = {
      release: expectedRelease,
      verificationUrl: `${baseUrl}/video`,
      failed: {
        generationId: failedGenerationId,
        httpStatus: failureResponse.status(),
        code: failureBody.code,
        inboundRequestId: failureBody.requestId,
        providerRequestId: failureBody.providerRequestId || null,
        providerClientRequestId: failureBody.providerClientRequestId,
        balanceBefore: before.remaining,
        balanceAfter: afterFailure.remaining,
        providerTaskId: failedStatus.providerTaskId || null,
      },
      completed: {
        generationId: completedGenerationId,
        inboundRequestId: submissionRequestId,
        status: current.status,
        creditCost: successBody.creditCost,
        balanceAfter: afterSuccess.remaining,
        videoUrl: safeVideoReference(current.videoUrl),
        snapshots: snapshots.map(item => ({
          status: item.status,
          stage: item.stage,
          progress: item.progress,
          timing: item.timing,
        })),
      },
    };
    fs.writeFileSync(path.join(evidenceDir, 'browser-and-api-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({
      release: expectedRelease,
      failedGenerationId,
      completedGenerationId,
      failedBalanceDelta: afterFailure.remaining - before.remaining,
      completedBalanceDelta: afterSuccess.remaining - before.remaining,
      terminalStatus: current.status,
    }));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
