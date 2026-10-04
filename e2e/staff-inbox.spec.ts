import { test, expect, type Page } from '@playwright/test';
const threadId = 'THREAD-UI-WATI';
async function fixture(page: Page, options: { denyAfterAction?: boolean; unknownContext?: boolean } = {}) {
  const writes: Array<Record<string, unknown>> = [], reads: string[] = [], views: Array<{name: string; view: unknown}> = [];
  let unread = 1, favourite = 0, retries = 0, denied = false;
  const now = Date.now();
  const thread = { id: threadId, customer_id: 'CUS-UI-WATI', customer_name: 'Synthetic customer', primary_phone: '••••1234', lead_id: 'LEAD-UI', status: 'open', assigned_to: 'fixture@pawspace.test', updated_at: now, unread: 1 };
  await page.addInitScript(() => { localStorage.setItem('pawspace.cookie-consent.v1', 'essential'); localStorage.setItem('pawspace.visual-style', 'professional'); });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') {
      const body = request.postDataJSON(); writes.push(body);
      if (url.pathname !== '/api/conversations') return route.fulfill({status: 409, json: {error: 'Synthetic UI blocks unrelated mutations'}});
      if (options.denyAfterAction) { denied = true; return route.fulfill({status: 403, json: {error: 'Conversation access denied'}}); }
      if (body.action === 'save_view') { const i = views.findIndex(row => row.name === body.name); if (i >= 0) views.splice(i, 1); views.push({name: body.name, view: body.view}); }
      if (body.action === 'delete_view') { const i = views.findIndex(row => row.name === body.name); if (i >= 0) views.splice(i, 1); }
      if (body.action === 'priority') { if (body.unread !== undefined) unread = body.unread ? 1 : 0; if (body.favourite !== undefined) favourite = body.favourite ? 1 : 0; }
      if (body.action === 'template_reply' && retries++ === 0) return route.abort('connectionreset');
      return route.fulfill({json: {data: {queued: true, messageId: 'MSG-UI', duplicatePrevented: retries > 1}}});
    }
    reads.push(url.pathname + url.search);
    if (url.pathname === '/api/conversations') {
      if (url.searchParams.get('view') === 'saved_views') return route.fulfill({json: {data: {views}}});
      if (url.searchParams.get('view') === 'template_catalog') return route.fulfill({json: {data: {templates: [
        {key: 'service_update', label: 'Service update', language: 'en_US', body: 'PawSpace has a service update. Reply here for help.', eligible: true, unavailableReason: null},
        {key: 'with_variable', label: 'Personal welcome', language: 'en', body: 'Hi {{1}}', eligible: false, unavailableReason: 'Variable templates need transport support; unavailable in this inbox'}
      ]}}});
      if (denied) return route.fulfill({status: 403, json: {error: 'Conversation access denied'}});
      if (url.searchParams.has('threadId')) return route.fulfill({json: {data: {thread, participants: [], assignments: [], notes: [], messages: [{id: 'IN-UI', direction: 'inbound', channel: 'whatsapp', payload: {text: 'Synthetic service enquiry'}, status: 'received', created_at: now - 25 * 3600000}], operatorState: {unread, favourite}, whatsappWindow: {checkedAt: now, expiresAt: now - 3600000, withinWindow: false}, context: {acquisition: {origin: options.unknownContext ? null : 'website', platform: options.unknownContext ? null : 'google', utmSource: 'google', utmMedium: 'cpc', utmCampaign: options.unknownContext ? null : 'Summer grooming', campaignId: null, adId: null, recordedAt: options.unknownContext ? null : now}, savedLocality: options.unknownContext ? null : {area: 'Indiranagar', city: 'Bengaluru'}}}}});
      return route.fulfill({json: {data: {threads: [{...thread, unread, favourite, lastMessage: {channel: 'whatsapp', text: 'Synthetic service enquiry', created_at: now}}], nextCursor: null}}});
    }
    if (url.pathname === '/api/whatsapp/conversation-control') return route.fulfill({json: {data: {threadId, customerId: 'CUS-UI-WATI', provider: 'sandbox_simulator', routing: {mode: 'human_only'}, handoff: {aiPaused: true, current: {status: 'staff_active'}, events: []}, canHumanReply: true}}});
    if (url.pathname === '/api/team-overview') return route.fulfill({json: {data: {actor: {name: 'Synthetic operator', email: 'fixture@pawspace.test', roleCode: 'founder', permissions: ['*']}, commandStrip: {}, workspaces: {}}}});
    if (url.pathname === '/api/appearance') return route.fulfill({json: {data: {preferences: null}}});
    return route.fulfill({status: 401, json: {error: 'Isolated UI fixture'}});
  });
  return {writes, reads};
}
for (const width of [1440, 390]) test(`staff triage, saved view, source and template retry at ${width}px`, async ({page}, info) => {
  await page.setViewportSize({width, height: 1000});
  const {writes, reads} = await fixture(page);
  await page.goto(`/team/customer-experience?threadId=${threadId}`);
  await expect(page.getByText('Summer grooming', {exact: true})).toBeVisible();
  const tools = page.getByRole('region', {name: 'Inbox views'});
  await expect(page.getByRole('button', {name: 'Assigned to me', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Assigned to me', exact: true}).click();
  await page.getByRole('button', {name: 'Unread', exact: true}).click();
  await page.getByRole('combobox', {name: 'Inbox channel'}).selectOption('whatsapp');
  await expect.poll(() => reads.some(value => value.includes('ownership=me') && value.includes('priority=unread') && value.includes('channel=whatsapp'))).toBe(true);
  await page.getByRole('textbox', {name: 'New saved view name'}).fill('My unread WhatsApp');
  await page.getByRole('button', {name: 'Save view', exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Saved inbox views'})).toHaveValue('My unread WhatsApp');
  const saved = writes.find(row => row.action === 'save_view')!;
  expect(saved.view).toEqual({channel: 'whatsapp', ownership: 'me', priority: 'unread', status: 'open', query: ''});
  await expect(page.getByText('Summer grooming', {exact: true})).toBeVisible();
  await expect(page.getByText('Indiranagar, Bengaluru', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Send', exact: true})).toBeDisabled();
  const select = page.getByRole('combobox', {name: 'Approved template and language'});
  await select.selectOption('service_update');
  await expect(select.locator('option[value=with_variable]')).toHaveAttribute('disabled', '');
  await expect(page.getByLabel('Template preview')).toHaveText('PawSpace has a service update. Reply here for help.');
  await page.screenshot({path: info.outputPath(`staff-inbox-${width}.png`), fullPage: true});
  const queue = page.getByRole('button', {name: 'Queue approved template', exact: true});
  await queue.click();
  await expect(queue).toBeEnabled();
  await queue.click();
  await expect(page.getByText('Approved template queued. The reply window opens when the customer responds.', {exact: true})).toBeVisible();
  const sends = writes.filter(row => row.action === 'template_reply');
  expect(sends).toHaveLength(2); expect(sends[0].clientRequestId).toBe(sends[1].clientRequestId); expect(sends[0].templateKey).toBe('service_update'); expect(sends[0].language).toBe('en_US'); expect(sends[0]).not.toHaveProperty('text');
  await page.getByRole('button', {name: 'Mark as read', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Mark as unread', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Add favourite', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Remove favourite', exact: true})).toBeVisible();
  expect(page.url()).toContain('threadId=' + threadId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const control of [select, tools, page.getByRole('combobox', {name: 'Saved inbox views'})]) {
    const box = await control.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
});

test('conversation access loss clears source context and prevents further template actions', async ({page}) => {
  await fixture(page, {denyAfterAction: true});
  await page.goto(`/team/customer-experience?threadId=${threadId}`);
  await expect(page.getByText('Summer grooming', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Add favourite', exact: true}).click();
  await expect(page.getByText('Summer grooming', {exact: true})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Approved template and language'})).toHaveCount(0);
});
