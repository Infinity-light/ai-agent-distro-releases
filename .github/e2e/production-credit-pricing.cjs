const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.E2E_BASE_URL || "https://zhiduoduoai.com";
const expectedRelease = process.env.EXPECTED_RELEASE;
const userToken = process.env.E2E_USER_TOKEN;
const adminToken = process.env.E2E_ADMIN_TOKEN;
const evidenceDir = path.resolve(
  process.env.E2E_EVIDENCE_DIR || "uat-artifacts",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function authenticatedContext(browser, token, viewport) {
  const context = await browser.newContext({
    viewport,
    locale: "zh-CN",
    deviceScaleFactor: 1,
  });
  await context.addCookies([
    {
      name: "token",
      value: token,
      domain: ".zhiduoduoai.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

async function verifyRelease(context, label) {
  const response = await context.request.get(`${baseUrl}/api/health`);
  assert(response.ok(), `${label}: health returned HTTP ${response.status()}`);
  const body = await response.json();
  const health = body.data || body;
  assert(health.status === "ok", `${label}: health is not ok`);
  assert(
    health.release === expectedRelease,
    `${label}: expected ${expectedRelease}, got ${health.release}`,
  );
}

function collectPageFailures(page) {
  const pageErrors = [];
  const serverErrors = [];
  const failedAssets = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500)
      serverErrors.push(`${response.status()} ${response.url()}`);
    if (
      response.status() >= 400 &&
      /\.(?:js|css|png|svg)(?:\?|$)/.test(response.url())
    ) {
      failedAssets.push(`${response.status()} ${response.url()}`);
    }
  });
  return () => {
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(" | ")}`);
    assert(
      serverErrors.length === 0,
      `5xx responses: ${serverErrors.join(" | ")}`,
    );
    assert(
      failedAssets.length === 0,
      `failed assets: ${failedAssets.join(" | ")}`,
    );
  };
}

async function verifyUser(browser) {
  const context = await authenticatedContext(browser, userToken, {
    width: 1440,
    height: 900,
  });
  const page = await context.newPage();
  const assertNoFailures = collectPageFailures(page);
  try {
    await verifyRelease(context, "user");
    await page.goto(`${baseUrl}/chat`, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    assert(
      new URL(page.url()).pathname === "/chat",
      `user was redirected to ${page.url()}`,
    );
    await page.getByLabel("每日积分领取").click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    await dialog.getByText("600 积分", { exact: false }).first().waitFor();
    const claimed = dialog.getByRole("button", { name: "今日已领取" });
    assert(
      await claimed.isDisabled(),
      "daily claim is not shown as completed after the API UAT",
    );
    await dialog
      .getByText(/剩余 \d+，已用 \d+/)
      .first()
      .waitFor();
    await page.screenshot({
      path: path.join(evidenceDir, "production-user-daily-claim.png"),
      fullPage: true,
    });
    assertNoFailures();
    return { url: page.url(), claimButtonDisabled: true };
  } finally {
    await context.close();
  }
}

async function verifyAdmin(browser) {
  const context = await authenticatedContext(browser, adminToken, {
    width: 1440,
    height: 1000,
  });
  const page = await context.newPage();
  const assertNoFailures = collectPageFailures(page);
  try {
    await verifyRelease(context, "admin");
    await page.goto(`${baseUrl}/admin/admin`, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    assert(
      new URL(page.url()).pathname === "/admin/admin",
      `admin was redirected to ${page.url()}`,
    );
    await page
      .getByText("每日积分领取监测（Asia/Shanghai）")
      .waitFor({ timeout: 20_000 });
    await page
      .getByText("文字 / 图片 / 视频统一账本，历史成本不可重算")
      .waitFor();
    await page.getByText("生产积分 UAT").first().waitFor();
    await page.screenshot({
      path: path.join(
        evidenceDir,
        "production-admin-credit-cost-monitoring.png",
      ),
      fullPage: true,
    });

    await page.goto(`${baseUrl}/admin/admin/config`, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    await page
      .getByText("模型定价与 Provider 对账")
      .waitFor({ timeout: 20_000 });
    await page.getByText("当前生效").first().waitFor();
    await page
      .getByText(/生产 UAT/)
      .first()
      .waitFor();
    await page.screenshot({
      path: path.join(evidenceDir, "production-admin-pricing-version.png"),
      fullPage: true,
    });
    assertNoFailures();
    return { dashboardUrl: `${baseUrl}/admin/admin`, pricingUrl: page.url() };
  } finally {
    await context.close();
  }
}

(async () => {
  assert(
    expectedRelease && /^[0-9a-f]{40}$/.test(expectedRelease),
    "EXPECTED_RELEASE must be a full SHA",
  );
  assert(userToken, "E2E_USER_TOKEN is required");
  assert(adminToken, "E2E_ADMIN_TOKEN is required");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const user = await verifyUser(browser);
    const admin = await verifyAdmin(browser);
    const report = {
      release: expectedRelease,
      testedAt: new Date().toISOString(),
      user,
      admin,
    };
    fs.writeFileSync(
      path.join(evidenceDir, "browser-uat.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
