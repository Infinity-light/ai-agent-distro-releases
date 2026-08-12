const { chromium } = require("playwright");

const baseUrl = process.env.E2E_BASE_URL || "https://zhiduoduoai.com";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyViewport(browser, viewport, label) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const page = await context.newPage();
  const pageErrors = [];
  const serverErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500)
      serverErrors.push(`${response.status()} ${response.url()}`);
  });

  try {
    const denied = await context.request.get(
      `${baseUrl}/api/ai/generate/video/options`,
    );
    assert(
      denied.status() === 401,
      `${label}: unauthenticated video options returned ${denied.status()}, expected 401`,
    );

    await page.goto(`${baseUrl}/video`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(1_000);

    const bodyText = await page.locator("body").innerText();
    assert(
      !bodyText.includes("AI 视频导演"),
      `${label}: public page exposed the video director entry`,
    );
    assert(
      !bodyText.includes("连续长片"),
      `${label}: public page exposed the long-video entry`,
    );

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert(
      dimensions.scrollWidth <= dimensions.clientWidth + 1,
      `${label}: horizontal overflow ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`,
    );
    assert(
      pageErrors.length === 0,
      `${label}: page errors: ${pageErrors.join(" | ")}`,
    );
    assert(
      serverErrors.length === 0,
      `${label}: 5xx responses: ${serverErrors.join(" | ")}`,
    );
    console.log(`${label} hidden-entry acceptance passed at ${page.url()}`);
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyViewport(
      browser,
      { width: 1440, height: 900 },
      "desktop-1440x900",
    );
    await verifyViewport(
      browser,
      { width: 375, height: 812 },
      "mobile-375x812",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
