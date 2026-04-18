/**
 * Teams wiggle sequence: refreshes all token families by exercising the UI.
 * Search for self → persona card → Organization tab → chat bubble.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} touched token families
 */
module.exports = async function wiggle(page) {
  const touched = [];

  // --- Search + Loki persona card sequence ---
  try {
    const search = page.locator('[data-tid="AUTOSUGGEST_INPUT"]').first();
    if ((await search.count()) > 0) {
      const homeUser = (process.env.HOME ?? "").split("/").pop() ?? "";
      const searchTerm = homeUser.replace(/[^a-zA-Z0-9._-]/g, "") || "me";

      await search.click({ timeout: 2000 });
      await search.fill(searchTerm);
      await page.waitForTimeout(3000);
      touched.push("search");

      const topHit = page.locator('[data-tid^="AUTOSUGGEST_SUGGESTION_TOPHITS"]').first();
      if ((await topHit.count()) > 0) {
        await topHit.hover({ timeout: 2000 });
        await page.waitForTimeout(500);

        const lpcBtn = page.locator('[data-tid="AUTOSUGGEST_ACTION_PERSONLPC"]').first();
        if ((await lpcBtn.count()) > 0) {
          await lpcBtn.click({ timeout: 2000 });
          await page.waitForTimeout(3000);
          touched.push("persona");

          const orgTab = page.locator('[role="tab"]', { hasText: "Organization" }).first();
          if ((await orgTab.count()) > 0) {
            await orgTab.click({ timeout: 2000 });
            await page.waitForTimeout(3000);
            touched.push("organization");
          }

          const chatBtn = page.locator('[id*="lpc"] button[aria-label^="Start a chat"]').first();
          if ((await chatBtn.count()) > 0) {
            await chatBtn.click({ timeout: 2000 });
            await page.waitForTimeout(1000);
            touched.push("compose");
          } else {
            const closeBtn = page.locator('button[aria-label="Close"]').last();
            await closeBtn.click({ timeout: 2000 }).catch(() => {});
            await search.press("Escape").catch(() => {});
          }
        }
      }

      if (!touched.includes("persona")) {
        await search.press("Escape").catch(() => {});
      }
    }
  } catch {}

  // Compose box fallback
  if (!touched.includes("compose")) {
    try {
      const compose = page
        .locator('[data-tid="ckeditor-replyConversation"], [data-tid="newMessageCommands"], [role="textbox"]')
        .first();
      if ((await compose.count()) > 0) {
        await compose.click({ timeout: 2000 });
        touched.push("compose");
      }
    } catch {}
  }

  // Click away to unfocus
  try {
    await page.locator("body").click({ position: { x: 10, y: 10 }, timeout: 1000 });
  } catch {}

  return touched;
};
