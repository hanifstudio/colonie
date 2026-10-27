// The rendered editor and native caret must use the same geometry. Run this
// against real conversation views, never the owner's app or real data.
export async function verifyChatComposer(page, { name, label, check, until }) {
  const input = page.locator('main [data-tour="composer"] textarea');
  const geometryOf = () => input.evaluate((textarea) => {
    const mirror = textarea.parentElement.querySelector(".mention-editor-mirror");
    const a = textarea.getBoundingClientRect(), b = mirror.getBoundingClientRect();
    const x = getComputedStyle(textarea), y = getComputedStyle(mirror);
    return { dx: a.x + parseFloat(x.paddingLeft) - b.x - parseFloat(y.paddingLeft), dy: a.y + parseFloat(x.paddingTop) - b.y - parseFloat(y.paddingTop), sameFont: x.font === y.font, sameWidth: textarea.clientWidth === mirror.clientWidth };
  });
  await input.fill("Check the cursor here");
  const geometry = await geometryOf();
  check(Math.abs(geometry.dx) < 0.5 && Math.abs(geometry.dy) < 0.5 && geometry.sameFont && geometry.sameWidth,
    `native caret and visible text align (${JSON.stringify(geometry)})`);

  const at = async (position, end = position) => {
    await input.focus();
    await input.press("Home");
    for (let i = 0; i < position; i++) await input.press("ArrowRight");
    for (let i = position; i < end; i++) await input.press("Shift+ArrowRight");
  };
  const options = page.locator('[role="listbox"] [role="option"]');
  const chosen = () => options.filter({ hasText: name });
  await input.fill("@");
  await until(page, async () => await options.count() > 0, "the mention roster opens at @");
  const count = await options.count();
  const firstOption = await input.getAttribute("aria-activedescendant");
  await input.press("ArrowDown");
  const nextOption = await input.getAttribute("aria-activedescendant");
  check((count === 1 ? nextOption === firstOption : nextOption !== firstOption) && await input.evaluate((element) => element.selectionStart) === 1, "arrow keys navigate the roster without moving the text caret");
  await input.press("ArrowUp");
  check(await input.getAttribute("aria-activedescendant") === firstOption, "ArrowUp returns to the previous suggestion");
  await input.press("Escape");
  const query = name.slice(0, name.indexOf(" ") + 3);
  const draft = `Before @${query} after`;
  await input.fill(draft); await at(`Before @${query}`.length);
  await until(page, async () => await chosen().count() === 1, "multiword mention suggestions follow the caret in the middle of a draft");
  await input.press("Enter");
  check(await input.inputValue() === `Before @${name} after`, "accepting a mention keeps the suffix and one separating space");
  check(await input.evaluate((element) => element.selectionStart) === `Before @${name} `.length, "the caret follows the accepted mention");

  await input.fill(`@${query}`);
  await until(page, async () => await chosen().count() === 1, "typing a name with spaces offers a match");
  await input.press("Escape");
  check(await input.inputValue() === `@${query}`, "Escape keeps the draft unchanged");
  await until(page, async () => await options.count() === 0, "Escape closes suggestions");

  await input.fill(`@${query}`); await input.press(" "); await input.press("Backspace");
  await until(page, async () => await chosen().count() === 1, "editing reopens suggestions");
  const accessible = await input.evaluate((element) => {
    const active = document.getElementById(element.getAttribute("aria-activedescendant"));
    const list = document.getElementById(element.getAttribute("aria-controls"));
    return active?.getAttribute("aria-selected") === "true" && list?.getAttribute("role") === "listbox";
  });
  check(accessible, "assistive technology can identify the active suggestion");
  await input.press("Shift+Enter");
  check(await input.inputValue() === `@${query}\n`, "Shift+Enter inserts a newline while suggestions are open");

  await input.fill(`@${query}`);
  await until(page, async () => await chosen().count() === 1, "Tab can accept a matching suggestion");
  await input.press("Tab");
  check(await input.inputValue() === `@${name} ` && await input.evaluate((element) => document.activeElement === element), "Tab completes the mention and keeps typing focus");

  await input.fill(`@${query}`);
  await until(page, async () => await chosen().count() === 1, "suggestions are available before mouse selection");
  await chosen().click();
  check(await input.inputValue() === `@${name} ` && await input.evaluate((element) => document.activeElement === element), "mouse selection keeps typing focus and closes the picker");
  await until(page, async () => await options.count() === 0, "an accepted mention does not immediately reopen");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await input.press(`${modifier}+z`);
  check(await input.inputValue() === `@${query}`, "Undo restores the unfinished mention");
  await input.press(`${modifier}+Shift+z`);
  check(await input.inputValue() === `@${name} `, "Redo restores the chosen mention");

  await input.fill(`@${query}`);
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  check(await input.inputValue() === `@${query}`, "IME confirmation neither accepts a mention nor sends the draft");
  await at(0, query.length + 1);
  await until(page, async () => await options.count() === 0, "selecting draft text closes suggestions");
  await input.fill(Array.from({ length: 12 }, (_, index) => `Line ${index}: @${name} and more text`).join("\n"));
  const scrolling = await input.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    const mirror = element.parentElement.querySelector(".mention-editor-mirror");
    return element.scrollTop > 0 && element.scrollTop === mirror.scrollTop && element.clientHeight === mirror.clientHeight;
  });
  check(scrolling, "long drafts scroll with the visible text aligned to the editor");
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 700, height: viewport.height });
  const oldSkin = await page.evaluate(() => {
    const old = document.documentElement.dataset.skin;
    document.documentElement.dataset.skin = "atelier";
    return old;
  });
  await input.fill(`@${name} Continue typing here`);
  await until(page, async () => {
    const geometry = await geometryOf();
    return Math.abs(geometry.dx) < 0.5 && Math.abs(geometry.dy) < 0.5 && geometry.sameFont && geometry.sameWidth;
  }, "text and caret still align in a narrow, light composer");
  if (process.env.COLONIE_COMPOSER_SCREENSHOTS) await page.locator('[data-tour="composer"]').screenshot({ path: `${process.env.COLONIE_COMPOSER_SCREENSHOTS}/${label}.png`, caret: "initial" });
  await page.evaluate((skin) => { if (skin) document.documentElement.dataset.skin = skin; else delete document.documentElement.dataset.skin; }, oldSkin);
  await page.setViewportSize(viewport);
  await input.fill("");
}
