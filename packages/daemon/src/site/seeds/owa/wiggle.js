/**
 * OWA wiggle sequence: navigate to inbox to refresh auth tokens.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} touched token families
 */
module.exports = async function wiggle(page) {
  const touched = [];

  try {
    await page.goto("https://outlook.cloud.microsoft/mail/", {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });
    await page.waitForTimeout(3000);
    touched.push("inbox");
  } catch {}

  try {
    const compose = page.locator('[aria-label="New mail"]').first();
    if ((await compose.count()) > 0) {
      await compose.click({ timeout: 2000 });
      await page.waitForTimeout(1000);
      touched.push("compose");

      const discard = page.locator('[aria-label="Discard"]').first();
      if ((await discard.count()) > 0) {
        await discard.click({ timeout: 2000 });
        await page.waitForTimeout(500);
      }
    }
  } catch {}

  return touched;
};
