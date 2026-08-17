const { chromium, request } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.E2E_BASE_URL || "https://zhiduoduoai.com";
const expectedRelease = process.env.EXPECTED_RELEASE;
const adminToken = process.env.E2E_ADMIN_TOKEN;
const normalToken = process.env.E2E_NORMAL_TOKEN;
const adminId = process.env.E2E_ADMIN_ID;
const mainConversationId = process.env.E2E_MAIN_CONVERSATION_ID;
const failureConversationId = process.env.E2E_FAILURE_CONVERSATION_ID;
const workId = process.env.E2E_WORK_ID;
const normalWorkId = process.env.E2E_NORMAL_WORK_ID;
const failedVideoId = process.env.E2E_FAILED_VIDEO_ID;
const choiceActionId = process.env.E2E_CHOICE_ACTION_ID;
const cancelActionId = process.env.E2E_CANCEL_ACTION_ID;
const denialActionId = process.env.E2E_DENIAL_ACTION_ID;
const successActionId = process.env.E2E_SUCCESS_ACTION_ID;
const evidenceDir = path.resolve(
  process.env.E2E_EVIDENCE_DIR || "uat-artifacts",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unwrap(body) {
  return body && body.code === 0 && Object.hasOwn(body, "data")
    ? body.data
    : body;
}

async function json(response, label, allowFailure = false) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `${label} returned non-JSON HTTP ${response.status()}: ${text.slice(0, 400)}`,
    );
  }
  if (!allowFailure && !response.ok()) {
    throw new Error(
      `${label} returned HTTP ${response.status()}: ${JSON.stringify(body).slice(0, 800)}`,
    );
  }
  return body;
}

function parseSse(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function balance(api) {
  const data = unwrap(
    await json(
      await api.get(`${baseUrl}/api/token-packs/balance`),
      "credit balance",
    ),
  );
  const remaining = Number(data.remaining ?? data.balance);
  assert(
    Number.isFinite(remaining),
    `Balance is not numeric: ${JSON.stringify(data)}`,
  );
  return { remaining, raw: data };
}

async function videoStatus(api, id) {
  return unwrap(
    await json(
      await api.get(`${baseUrl}/api/ai/generate/video/status/${id}`),
      `video status ${id}`,
    ),
  );
}

async function waitForTerminal(api, id, timeoutMs) {
  const snapshots = [];
  const deadline = Date.now() + timeoutMs;
  let current = await videoStatus(api, id);
  snapshots.push(current);
  while (
    !["COMPLETED", "FAILED", "CANCELLED"].includes(current.status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    current = await videoStatus(api, id);
    snapshots.push(current);
  }
  return { current, snapshots };
}

function actionCard(page, question) {
  return page.locator(".ant-card").filter({ hasText: question }).first();
}

function appendGithubEnv(name, value) {
  if (process.env.GITHUB_ENV)
    fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

(async () => {
  for (const [name, value] of Object.entries({
    EXPECTED_RELEASE: expectedRelease,
    E2E_ADMIN_TOKEN: adminToken,
    E2E_NORMAL_TOKEN: normalToken,
    E2E_ADMIN_ID: adminId,
    E2E_MAIN_CONVERSATION_ID: mainConversationId,
    E2E_FAILURE_CONVERSATION_ID: failureConversationId,
    E2E_WORK_ID: workId,
    E2E_NORMAL_WORK_ID: normalWorkId,
    E2E_FAILED_VIDEO_ID: failedVideoId,
    E2E_CHOICE_ACTION_ID: choiceActionId,
    E2E_CANCEL_ACTION_ID: cancelActionId,
    E2E_DENIAL_ACTION_ID: denialActionId,
    E2E_SUCCESS_ACTION_ID: successActionId,
  }))
    assert(value, `${name} is missing`);
  assert(
    /^[0-9a-f]{40}$/.test(expectedRelease),
    "EXPECTED_RELEASE is not an immutable SHA",
  );
  fs.mkdirSync(evidenceDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: "zh-CN",
  });
  await adminContext.addCookies([
    {
      name: "token",
      value: adminToken,
      domain: ".zhiduoduoai.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const normalApi = await request.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${normalToken}` },
  });
  const page = await adminContext.newPage();
  const pageErrors = [];
  const unexpectedResponses = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 500)
      unexpectedResponses.push(
        `${response.status()} ${response.request().method()} ${pathname}`,
      );
  });

  let successGenerationId = "";
  let retryGenerationId = "";
  const evidence = {
    release: expectedRelease,
    verificationUrls: [`${baseUrl}/chat`, `${baseUrl}/works`],
    permissions: {},
    imageOnly: {},
    sessionRestore: {},
    choice: {},
    cancelledConfirmation: {},
    deniedConfirmation: {},
    successfulConfirmation: {},
    retryAndCancel: {},
  };

  try {
    const health = unwrap(
      await json(
        await adminContext.request.get(`${baseUrl}/api/health`),
        "production health",
      ),
    );
    assert(health.status === "ok", `Production health is ${health.status}`);
    assert(
      health.release === expectedRelease,
      `Expected ${expectedRelease}, got ${health.release}`,
    );

    const adminMaterials = unwrap(
      await json(
        await adminContext.request.get(`${baseUrl}/api/ai/chat/materials`),
        "administrator material library",
      ),
    );
    const normalMaterials = unwrap(
      await json(
        await normalApi.get(`${baseUrl}/api/ai/chat/materials`),
        "normal-user material library",
      ),
    );
    assert(
      adminMaterials.items.some((item) => item.id === "portrait:primary"),
      "Saved portrait is absent for its owner",
    );
    assert(
      adminMaterials.items.some((item) => item.id === `work:${workId}`),
      "Saved work is absent for its owner",
    );
    assert(
      !adminMaterials.items.some((item) => item.id === `work:${normalWorkId}`),
      "Another user's work leaked into administrator materials",
    );
    assert(
      normalMaterials.items.some((item) => item.id === `work:${normalWorkId}`),
      "Normal user cannot see their own saved work",
    );
    assert(
      !normalMaterials.items.some((item) => item.id === `work:${workId}`),
      "Administrator work leaked into another user's materials",
    );
    const unauthorizedRead = await normalApi.get(
      `${baseUrl}/api/ai/generate/works/${workId}`,
    );
    const unauthorizedReadBody = await json(
      unauthorizedRead,
      "cross-owner work read",
      true,
    );
    assert(
      [400, 403, 404].includes(unauthorizedRead.status()),
      `Cross-owner work read returned ${unauthorizedRead.status()}`,
    );
    evidence.permissions = {
      ownerMaterialIds: adminMaterials.items.map((item) => item.id),
      otherUserMaterialIds: normalMaterials.items.map((item) => item.id),
      crossOwnerReadStatus: unauthorizedRead.status(),
      crossOwnerReadMessage: unauthorizedReadBody.message || null,
    };

    await page.addInitScript(
      ({ key, conversationId }) => {
        localStorage.setItem(key, conversationId);
      },
      {
        key: `zdd-ai-chat:last:${adminId}`,
        conversationId: mainConversationId,
      },
    );
    await page.goto(`${baseUrl}/chat`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page
      .getByText("生产 UAT：请选择可追踪的创作目标。", { exact: true })
      .waitFor({ timeout: 30_000 });

    await page.getByRole("button", { name: "个人形象与图库" }).click();
    await page
      .locator('[data-material-id="portrait:primary"]')
      .waitFor({ timeout: 20_000 });
    await page
      .locator(`[data-material-id="work:${workId}"]`)
      .waitFor({ timeout: 20_000 });
    await page.getByText("生产验收真实画像", { exact: true }).waitFor();
    await page.getByText("生产验收作品图库", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(evidenceDir, "01-real-saved-material-library.png"),
      fullPage: true,
    });
    await page.locator('[data-material-id="portrait:primary"]').click();
    await page.getByRole("button", { name: /使用所选素材/ }).click();

    const imageOnlyRequestPromise = page.waitForRequest(
      (request) => {
        return (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/ai/chat/send/stream"
        );
      },
      { timeout: 30_000 },
    );
    const imageOnlyResponsePromise = page.waitForResponse(
      (response) => {
        return (
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/ai/chat/send/stream"
        );
      },
      { timeout: 120_000 },
    );
    await page.locator(".ai-chat-composer button").click();
    const imageOnlyRequest = await imageOnlyRequestPromise;
    const imageOnlyBody = imageOnlyRequest.postDataJSON();
    assert(
      imageOnlyBody.message === "",
      `Image-only send unexpectedly included text: ${imageOnlyBody.message}`,
    );
    assert(
      JSON.stringify(imageOnlyBody.referenceMaterialIds) ===
        JSON.stringify(["portrait:primary"]),
      `Image-only send references are ${JSON.stringify(imageOnlyBody.referenceMaterialIds)}`,
    );
    const imageOnlyResponse = await imageOnlyResponsePromise;
    assert(
      imageOnlyResponse.status() === 200,
      `Image-only stream returned ${imageOnlyResponse.status()}`,
    );
    const streamEvents = parseSse(await imageOnlyResponse.text());
    const streamError = streamEvents.find((event) => event.type === "error");
    const streamDone = streamEvents.findLast((event) => event.type === "done");
    assert(
      !streamError,
      `Image-only stream failed: ${JSON.stringify(streamError)}`,
    );
    assert(
      streamDone?.payload?.assistantMessageId,
      "Image-only stream did not produce a persisted assistant message",
    );
    const conversationAfterImage = unwrap(
      await json(
        await adminContext.request.get(
          `${baseUrl}/api/ai/chat/conversations/${mainConversationId}`,
        ),
        "conversation after image-only send",
      ),
    );
    const imageOnlyUserMessage = [...conversationAfterImage.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          message.content === "" &&
          Array.isArray(message.attachments) &&
          message.attachments.some(
            (item) =>
              item.type === "material_ref" &&
              item.materialId === "portrait:primary",
          ),
      );
    assert(
      imageOnlyUserMessage,
      "Image-only material reference was not persisted on the user message",
    );
    evidence.imageOnly = {
      requestBody: imageOnlyBody,
      assistantMessageId: streamDone.payload.assistantMessageId,
      persistedUserMessageId: imageOnlyUserMessage.id,
      streamEventTypes: streamEvents.map((event) => event.type),
    };
    await page.screenshot({
      path: path.join(evidenceDir, "02-image-only-real-deepseek-response.png"),
      fullPage: true,
    });

    await page.goto(`${baseUrl}/works`, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    const restoredConversationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/ai/chat/conversations/${mainConversationId}`,
      { timeout: 30_000 },
    );
    await page.goto(`${baseUrl}/chat`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const restoredResponse = await restoredConversationResponse;
    assert(
      restoredResponse.ok(),
      `Restored conversation returned ${restoredResponse.status()}`,
    );
    await page
      .getByText("生产 UAT：请选择可追踪的创作目标。", { exact: true })
      .waitFor({ timeout: 30_000 });
    const storedConversationId = await page.evaluate(
      (key) => localStorage.getItem(key),
      `zdd-ai-chat:last:${adminId}`,
    );
    assert(
      storedConversationId === mainConversationId,
      `Restored local conversation is ${storedConversationId}`,
    );
    evidence.sessionRestore = {
      conversationId: mainConversationId,
      localStorageConversationId: storedConversationId,
    };
    await page.screenshot({
      path: path.join(
        evidenceDir,
        "03-conversation-restored-after-navigation.png",
      ),
      fullPage: true,
    });

    const choiceCard = actionCard(page, "这条片子优先解决什么？");
    const choiceRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          `/api/ai/chat/actions/${choiceActionId}/invoke`,
      { timeout: 30_000 },
    );
    const choiceResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/ai/chat/actions/${choiceActionId}/invoke`,
      { timeout: 120_000 },
    );
    await choiceCard.getByRole("button", { name: /转化优先/ }).click();
    const choiceRequest = await choiceRequestPromise;
    const choiceBody = choiceRequest.postDataJSON();
    const choiceResponse = await choiceResponsePromise;
    const choiceData = unwrap(
      await json(choiceResponse, "choice action invoke"),
    );
    assert(
      choiceBody.optionIds?.[0] === "conversion",
      `Choice action sent ${JSON.stringify(choiceBody)}`,
    );
    assert(
      /^chat-action:/.test(choiceBody.requestKey),
      `Choice request key is ${choiceBody.requestKey}`,
    );
    assert(
      choiceData.invokedAction?.status === "COMPLETED",
      `Choice action is ${choiceData.invokedAction?.status}`,
    );
    const choiceReplay = unwrap(
      await json(
        await adminContext.request.post(
          `${baseUrl}/api/ai/chat/actions/${choiceActionId}/invoke`,
          { data: choiceBody },
        ),
        "choice action idempotent replay",
      ),
    );
    assert(
      choiceReplay.idempotentReplay === true,
      "Choice action replay was not marked idempotent",
    );
    assert(
      choiceReplay.assistantMessageId === choiceData.assistantMessageId,
      "Choice action replay changed the result",
    );
    evidence.choice = {
      actionId: choiceActionId,
      requestKey: choiceBody.requestKey,
      selectedOptionIds: choiceBody.optionIds,
      assistantMessageId: choiceData.assistantMessageId,
      replay: choiceReplay.idempotentReplay,
    };
    await page.screenshot({
      path: path.join(evidenceDir, "04-clickable-choice-backend-action.png"),
      fullPage: true,
    });

    const beforeCancelConfirmation = await balance(adminContext.request);
    const cancelCard = actionCard(page, "是否取消这份报价而不创建任务？");
    const cancelResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/ai/chat/actions/${cancelActionId}/invoke`,
      { timeout: 30_000 },
    );
    await cancelCard.getByRole("button", { name: /取消生成（UAT）/ }).click();
    const cancelData = unwrap(
      await json(await cancelResponsePromise, "cancel confirmation action"),
    );
    assert(
      cancelData.invokedAction?.status === "CANCELLED",
      `Cancel action is ${cancelData.invokedAction?.status}`,
    );
    const afterCancelConfirmation = await balance(adminContext.request);
    assert(
      afterCancelConfirmation.remaining === beforeCancelConfirmation.remaining,
      `Cancelled confirmation changed balance ${beforeCancelConfirmation.remaining} -> ${afterCancelConfirmation.remaining}`,
    );
    evidence.cancelledConfirmation = {
      actionId: cancelActionId,
      status: cancelData.invokedAction.status,
      balanceBefore: beforeCancelConfirmation.remaining,
      balanceAfter: afterCancelConfirmation.remaining,
    };

    const beforeDenial = await balance(adminContext.request);
    const denialCard = actionCard(
      page,
      "确认使用另一账号的素材吗？系统必须拒绝。",
    );
    const denialResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/ai/chat/actions/${denialActionId}/invoke`,
      { timeout: 30_000 },
    );
    await denialCard
      .getByRole("button", { name: /确认越权方案（应拒绝）/ })
      .click();
    const denialData = unwrap(
      await json(
        await denialResponsePromise,
        "cross-owner confirmation denial",
      ),
    );
    assert(
      denialData.invokedAction?.status === "FAILED",
      `Cross-owner action is ${denialData.invokedAction?.status}`,
    );
    assert(
      denialData.toolResults?.[0]?.success === false,
      "Cross-owner action did not return a failed tool result",
    );
    assert(
      /无权|不在你的可用素材库/.test(denialData.toolResults[0].message || ""),
      `Cross-owner denial feedback is ${denialData.toolResults[0].message}`,
    );
    const afterDenial = await balance(adminContext.request);
    assert(
      afterDenial.remaining === beforeDenial.remaining,
      `Denied material action changed balance ${beforeDenial.remaining} -> ${afterDenial.remaining}`,
    );
    evidence.deniedConfirmation = {
      actionId: denialActionId,
      status: denialData.invokedAction.status,
      code: denialData.toolResults[0].code,
      retryable: denialData.toolResults[0].retryable,
      message: denialData.toolResults[0].message,
      balanceBefore: beforeDenial.remaining,
      balanceAfter: afterDenial.remaining,
    };
    await page.screenshot({
      path: path.join(evidenceDir, "05-cross-owner-material-rejected.png"),
      fullPage: true,
    });

    const beforeSuccess = await balance(adminContext.request);
    const successCard = actionCard(
      page,
      "确认使用你自己的作品素材生成 4 秒短视频吗？",
    );
    const successRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          `/api/ai/chat/actions/${successActionId}/invoke`,
      { timeout: 30_000 },
    );
    const successResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/ai/chat/actions/${successActionId}/invoke`,
      { timeout: 90_000 },
    );
    await successCard
      .getByRole("button", { name: /确认生成自有素材短片/ })
      .click();
    const successRequest = await successRequestPromise;
    const successBody = successRequest.postDataJSON();
    assert(
      Object.keys(successBody).sort().join(",") === "optionIds,requestKey",
      `Browser supplied executable confirmation fields: ${Object.keys(successBody).join(",")}`,
    );
    const successResponse = await successResponsePromise;
    const successData = unwrap(
      await json(successResponse, "successful confirmation action"),
    );
    const successTool = successData.toolResults?.find(
      (item) => item.toolName === "generate_video",
    );
    assert(
      successData.invokedAction?.status === "COMPLETED",
      `Success action is ${successData.invokedAction?.status}`,
    );
    assert(
      successTool?.success && successTool.data?.id,
      `Success tool result is ${JSON.stringify(successTool)}`,
    );
    successGenerationId = successTool.data.id;
    appendGithubEnv("E2E_SUCCESS_GENERATION_ID", successGenerationId);
    const successReplay = unwrap(
      await json(
        await adminContext.request.post(
          `${baseUrl}/api/ai/chat/actions/${successActionId}/invoke`,
          { data: successBody },
        ),
        "successful confirmation idempotent replay",
      ),
    );
    const replayGenerationId = successReplay.toolResults?.find(
      (item) => item.toolName === "generate_video",
    )?.data?.id;
    assert(
      successReplay.idempotentReplay === true,
      "Successful confirmation replay was not marked idempotent",
    );
    assert(
      replayGenerationId === successGenerationId,
      "Confirmation replay created or returned a different generation",
    );

    await page
      .getByText(/实际进度：/)
      .last()
      .waitFor({ timeout: 30_000 });
    await page
      .getByText(/已耗时：/)
      .last()
      .waitFor({ timeout: 30_000 });
    const initialStatus = await videoStatus(
      adminContext.request,
      successGenerationId,
    );
    assert(
      initialStatus.stage?.code && initialStatus.stage?.detail,
      "Confirmed task has no backend stage",
    );
    assert(
      initialStatus.progress &&
        Number.isFinite(initialStatus.progress.totalUnits),
      "Confirmed task has no backend progress",
    );
    assert(
      initialStatus.timing &&
        Number.isFinite(initialStatus.timing.elapsedSeconds),
      "Confirmed task has no elapsed time",
    );
    assert(
      initialStatus.timing.eta?.basis,
      "Confirmed task has no evidence-based ETA",
    );
    const resumeButton = page
      .getByRole("button", { name: "刷新并恢复" })
      .last();
    if (await resumeButton.isVisible()) await resumeButton.click();
    await page.screenshot({
      path: path.join(evidenceDir, "06-confirmed-task-real-progress-eta.png"),
      fullPage: true,
    });

    const completed = await waitForTerminal(
      adminContext.request,
      successGenerationId,
      22 * 60_000,
    );
    assert(
      completed.current.status === "COMPLETED",
      `Confirmed short video ended as ${completed.current.status}: ${completed.current.errorMessage || ""}`,
    );
    assert(
      completed.current.videoUrl,
      "Confirmed short video has no output URL",
    );
    assert(
      completed.current.stage?.code === "succeeded",
      `Terminal stage is ${completed.current.stage?.code}`,
    );
    assert(
      completed.current.progress?.completedUnits ===
        completed.current.progress?.totalUnits,
      "Terminal progress does not reflect completion",
    );
    const resolvedVideoUrl = new URL(
      completed.current.videoUrl,
      baseUrl,
    ).toString();
    const outputResponse = await adminContext.request.get(resolvedVideoUrl, {
      timeout: 60_000,
    });
    assert(
      outputResponse.ok(),
      `Generated video returned ${outputResponse.status()}`,
    );
    await page
      .locator(`video[src="${completed.current.videoUrl}"]`)
      .waitFor({ timeout: 45_000 })
      .catch(async () => {
        await page.locator("video").last().waitFor({ timeout: 15_000 });
      });
    const afterSuccess = await balance(adminContext.request);
    assert(
      afterSuccess.remaining === beforeSuccess.remaining - 400,
      `Successful video expected 400 credits, balance ${beforeSuccess.remaining} -> ${afterSuccess.remaining}`,
    );
    evidence.successfulConfirmation = {
      actionId: successActionId,
      generationId: successGenerationId,
      requestKey: successBody.requestKey,
      inboundRequestId: successResponse.headers()["x-request-id"] || null,
      replay: successReplay.idempotentReplay,
      balanceBefore: beforeSuccess.remaining,
      balanceAfter: afterSuccess.remaining,
      videoUrl: `${new URL(resolvedVideoUrl).origin}${new URL(resolvedVideoUrl).pathname}`,
      status: completed.current.status,
      snapshots: completed.snapshots.map((item) => ({
        status: item.status,
        stage: item.stage,
        progress: item.progress,
        timing: item.timing,
      })),
    };
    await page.screenshot({
      path: path.join(
        evidenceDir,
        "07-confirmed-saved-material-video-completed.png",
      ),
      fullPage: true,
    });

    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: `zdd-ai-chat:last:${adminId}`,
      value: failureConversationId,
    });
    await page.goto(`${baseUrl}/works`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.goto(`${baseUrl}/chat`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page
      .getByText("生产验收：上游明确返回失败，可安全重试")
      .waitFor({ timeout: 30_000 });
    const beforeRetry = await balance(adminContext.request);
    const retryRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname ===
          `/api/ai/generate/video/${failedVideoId}/retry`,
      { timeout: 30_000 },
    );
    const retryResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/ai/generate/video/${failedVideoId}/retry`,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "重试（新任务）" }).click();
    await page.getByRole("button", { name: "确认重试" }).click();
    const retryRequest = await retryRequestPromise;
    const retryBody = retryRequest.postDataJSON();
    assert(
      /^video-retry:/.test(retryBody.requestKey),
      `Retry request key is ${retryBody.requestKey}`,
    );
    const retryData = unwrap(
      await json(await retryResponsePromise, "failed-video retry"),
    );
    assert(
      retryData.id && retryData.id !== failedVideoId,
      "Retry did not create a distinct task",
    );
    retryGenerationId = retryData.id;
    appendGithubEnv("E2E_RETRY_GENERATION_ID", retryGenerationId);
    const retryReplay = unwrap(
      await json(
        await adminContext.request.post(
          `${baseUrl}/api/ai/generate/video/${failedVideoId}/retry`,
          { data: retryBody },
        ),
        "video retry idempotent replay",
      ),
    );
    assert(
      retryReplay.id === retryGenerationId,
      "Retry replay created a second task",
    );
    await page
      .getByRole("button", { name: "取消任务" })
      .last()
      .waitFor({ timeout: 30_000 });
    const cancelTaskResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/ai/generate/video/${retryGenerationId}/cancel`,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "取消任务" }).last().click();
    await page.getByRole("button", { name: "确认取消" }).click();
    const cancelTaskData = unwrap(
      await json(await cancelTaskResponsePromise, "retried-video cancellation"),
    );
    assert(
      cancelTaskData.status === "CANCELLED",
      `Cancellation returned ${cancelTaskData.status}`,
    );
    const retryTerminal = await waitForTerminal(
      adminContext.request,
      retryGenerationId,
      120_000,
    );
    assert(
      retryTerminal.current.status === "CANCELLED",
      `Retried task ended as ${retryTerminal.current.status}`,
    );
    assert(
      retryTerminal.current.stage?.code === "cancelled",
      `Cancelled stage is ${retryTerminal.current.stage?.code}`,
    );
    const afterRetryCancel = await balance(adminContext.request);
    assert(
      afterRetryCancel.remaining === beforeRetry.remaining,
      `Retry/cancel changed balance ${beforeRetry.remaining} -> ${afterRetryCancel.remaining}`,
    );
    evidence.retryAndCancel = {
      originalFailedGenerationId: failedVideoId,
      retryGenerationId,
      requestKey: retryBody.requestKey,
      idempotentReplayGenerationId: retryReplay.id,
      status: retryTerminal.current.status,
      stage: retryTerminal.current.stage,
      balanceBefore: beforeRetry.remaining,
      balanceAfter: afterRetryCancel.remaining,
    };
    await page.screenshot({
      path: path.join(evidenceDir, "08-failed-retry-cancel-zero-charge.png"),
      fullPage: true,
    });

    assert(
      pageErrors.length === 0,
      `Browser page errors: ${pageErrors.join(" | ")}`,
    );
    assert(
      unexpectedResponses.length === 0,
      `Unexpected production 5xx: ${unexpectedResponses.join(" | ")}`,
    );
    evidence.pageErrors = pageErrors;
    evidence.unexpectedResponses = unexpectedResponses;
    fs.writeFileSync(
      path.join(evidenceDir, "browser-and-api-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        release: expectedRelease,
        mainConversationId,
        successGenerationId,
        retryGenerationId,
        successStatus: evidence.successfulConfirmation.status,
        retryStatus: evidence.retryAndCancel.status,
        crossOwnerDenied: evidence.deniedConfirmation.status === "FAILED",
      }),
    );
  } finally {
    await normalApi.dispose();
    await adminContext.close();
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
