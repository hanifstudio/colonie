// Run inside the disposable Shared workspace journey, on the built app and
// scripted ACP engine. This proves the real UI, routing and controls, not
// a model's understanding of natural-language scheduling.
export async function verifyRoutines(page, { botId, botName, check, until }) {
  const input = page.locator('main [data-tour="composer"] textarea');
  const routines = () => page.evaluate(async () => (await (await fetch('/api/routines')).json()).routines);
  const runState = () => page.evaluate(async () => (await (await fetch('/api/routines')).json()).runs);
  const tools = (name, args) => `mcp call colonie_workspace ${name} ${JSON.stringify(args)}`;
  const button = () => page.getByRole('button', { name: /^Routines in this conversation/ });
  const dialog = () => page.getByRole('dialog', { name: 'Routines in this conversation', exact: true });
  const schedule = async (name, prefix = '') => {
    await input.fill(`${prefix}${tools('schedule_routine', { name, instructions: `Report ${name} with a [source](https://example.com/report).`, requestId: `journey-${name.replaceAll(' ', '-')}`, schedule: { type: 'weekly', time: '09:00', weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] } })}`);
    await input.press('Enter');
    await until(page, async () => (await routines()).some((routine) => routine.name === name), `${name} is scheduled from chat`);
    return (await routines()).find((routine) => routine.name === name);
  };
  const open = async () => { await button().click(); await dialog().waitFor(); };
  const shot = async (name) => {
    if (process.env.COLONIE_ROUTINE_SCREENSHOTS) await page.screenshot({ path: `${process.env.COLONIE_ROUTINE_SCREENSHOTS}/${name}.png` });
  };
  const personal = await schedule('Morning brief');
  await open();
  check((await dialog().innerText()).includes('Morning brief') && (await dialog().innerText()).includes('Next'), 'the DM lists its routine and next run');
  await dialog().getByRole('button', { name: 'Pause', exact: true }).click();
  await until(page, async () => await dialog().getByRole('button', { name: 'Resume', exact: true }).count() === 1, 'Pause updates the routine in place');
  await dialog().getByRole('button', { name: 'Resume', exact: true }).click();
  await until(page, async () => await dialog().getByRole('button', { name: 'Pause', exact: true }).count() === 1, 'Resume restores the schedule');
  await shot('dm-dark');
  await dialog().getByRole('button', { name: 'Close routines' }).click();
  await input.fill('Keep this note'); await open();
  await dialog().getByRole('button', { name: 'Edit in chat' }).click();
  await until(page, async () => (await input.inputValue()).startsWith('Keep this note\n\nChange the routine "Morning brief": '), 'Edit in chat keeps the existing draft');
  await until(page, async () => input.evaluate((element) => document.activeElement === element), 'Edit in chat returns typing focus');
  await input.fill(tools('change_routine', { action: 'update', routineId: personal.id, name: 'Later brief', schedule: { type: 'weekly', time: '10:00', weekdays: ['friday'] }, requestId: 'journey-edit-brief' }));
  await input.press('Enter');
  await until(page, async () => (await routines()).some((routine) => routine.id === personal.id && routine.name === 'Later brief' && routine.schedule.time === '10:00'), 'a chat edit changes the existing routine');
  await open();
  await dialog().getByRole('button', { name: 'Run now', exact: true }).click();
  await until(page, async () => (await runState()).some((run) => run.routineId === personal.id && run.status === 'completed'), 'Run now completes through the app scheduler');
  await dialog().getByRole('button', { name: 'Close routines' }).click();
  await until(page, async () => page.locator('section[aria-label="Later brief routine run: Completed"]').count() === 1, 'one completed report appears in the originating DM');
  check(await page.locator('section[aria-label="Later brief routine run: Completed"] a[href="https://example.com/report"]').count() > 0, 'the routine report keeps its clickable source');

  await page.locator('section[aria-label="Groups and people"] button', { hasText: 'Launch' }).first().click();
  await until(page, async () => (await input.getAttribute('placeholder') ?? '').includes('Launch'), 'the originating group is open');
  const groupRoutine = await schedule('Launch roundup', `@${botName} `);
  check(groupRoutine.conversation?.id && groupRoutine.conversation.threadId !== personal.conversation.threadId, 'the group routine has its own destination');
  await open();
  check(!(await dialog().innerText()).includes('Later brief'), 'the group does not list the bot DM routine');
  await dialog().getByRole('button', { name: 'Run now', exact: true }).click();
  await until(page, async () => (await runState()).some((run) => run.routineId === groupRoutine.id && run.status === 'completed'), 'the group routine completes');
  await shot('group-dark');
  const viewport = page.viewportSize();
  const skin = await page.evaluate(() => document.documentElement.dataset.skin);
  await page.evaluate(() => { document.documentElement.dataset.skin = 'daylight'; });
  await shot('group-light');
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the narrow routine dialog has no horizontal overflow');
  await shot('group-narrow');
  await page.setViewportSize(viewport);
  await page.evaluate((value) => { if (value) document.documentElement.dataset.skin = value; else delete document.documentElement.dataset.skin; }, skin);
  await dialog().getByRole('button', { name: 'Close routines' }).click();
  await until(page, async () => page.locator('section[aria-label="Launch roundup routine run: Completed"]').count() === 1, 'one report appears in the group');
  await open();
  await dialog().getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete routine', exact: true }).click();
  await until(page, async () => !(await routines()).some((routine) => routine.id === groupRoutine.id), 'Delete removes future group runs');
  check((await dialog().innerText()).includes('Let a bot take care of it regularly'), 'the empty state explains scheduling in chat');
  await dialog().getByRole('button', { name: 'Close routines' }).click();
  check(await page.locator('section[aria-label="Launch roundup routine run: Completed"]').count() === 1, 'deleting a routine preserves its report');
  await page.locator(`[data-sidebar-bot-row="${botId}"]`).click();
  check(await page.locator('section[aria-label="Launch roundup routine run: Completed"]').count() === 0, 'the group report does not appear in the personal DM');
}
