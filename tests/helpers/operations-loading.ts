import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Pool } from 'pg';

/** Test-only barriers exercise real streaming and router transitions. */
export async function verifyLoading(
  page: Page,
  admin: Pool,
  overview: string,
  screenshotDir: string,
) {
  await mkdir(screenshotDir, { recursive: true });
  const base = new URL(overview);
  const sectionUrl = (section: string) => {
    const next = new URL(base);
    next.pathname = '/' + section;
    return next.href;
  };
  const skeleton = page.locator('.page-skeleton:visible');
  const blocker = await admin.connect();
  try {
    // Hold the real approved read without changing any application query.
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE ledger.book IN ACCESS EXCLUSIVE MODE');
    await page.goto(overview, { waitUntil: 'commit' });
    await skeleton.waitFor();
    assert.equal(
      await page.locator('nav[aria-label="Primary"]').isVisible(),
      true,
    );
    assert.equal(
      await page
        .getByRole('heading', { name: 'Financial operations', exact: true })
        .isVisible(),
      true,
    );
    assert.equal(await page.locator('.page-skeleton .status').count(), 0);
    assert.equal(
      await page.locator('.page-skeleton').getAttribute('aria-busy'),
      'true',
    );
    const loadingMetrics = await page.locator('.metric-grid').boundingBox();
    assert(loadingMetrics);
    const loadingPanels = await page
      .locator('.page-skeleton .panel')
      .evaluateAll((elements) =>
        elements.slice(0, 2).map((el) => el.getBoundingClientRect().y),
      );
    assert.notEqual(
      await page
        .locator('.skeleton')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'none',
    );
    await page.screenshot({
      path: join(screenshotDir, 'overview-loading-wide.png'),
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await page
        .locator('.skeleton')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'none',
    );
    await page.setViewportSize({ width: 640, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: join(screenshotDir, 'overview-loading-narrow.png'),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await blocker.query('ROLLBACK');
    await skeleton.waitFor({ state: 'hidden' });
    const loadedMetrics = await page.locator('.metric-grid').boundingBox();
    assert(loadedMetrics);
    const loadedPanels = await page
      .locator('main .panel')
      .evaluateAll((elements) =>
        elements.slice(0, 2).map((el) => el.getBoundingClientRect().y),
      );
    await page.screenshot({
      path: join(screenshotDir, 'overview-loaded-wide.png'),
    });
    assert(
      Math.abs(loadingMetrics.y - loadedMetrics.y) <= 4,
      'Metric cards keep their vertical position',
    );
    assert(
      Math.abs(loadingMetrics.height - loadedMetrics.height) <= 24,
      `Metric placeholders approximate final height (${loadingMetrics.height} → ${loadedMetrics.height})`,
    );
    loadingPanels.forEach((position, i) =>
      assert(
        Math.abs(position - loadedPanels[i]!) <= 24,
        'Summary panels keep their approximate position',
      ),
    );
    assert.equal(
      await page.getByRole('button', { name: 'Refresh data' }).isEnabled(),
      true,
    );

    // A new section gets its own fallback while the shell stays visible.
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE ledger.book IN ACCESS EXCLUSIVE MODE');
    await page.locator('nav a').filter({ hasText: 'Controls' }).click();
    await skeleton.waitFor();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(
      await page.locator('.page-skeleton .filters .skeleton-input').count(),
      4,
    );
    assert.equal(
      await page
        .locator('.skeleton')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
      'none',
    );
    await page.screenshot({
      path: join(screenshotDir, 'controls-loading-wide.png'),
    });
    await blocker.query('ROLLBACK');
    await skeleton.waitFor({ state: 'hidden' });
    await page
      .getByRole('heading', { name: 'Financial controls', exact: true })
      .waitFor();

    // Use a response barrier, rather than timing guesses, to examine an update.
    async function retainedUpdate(
      action: () => Promise<unknown>,
      indicator: string,
    ) {
      const before = await page
        .locator('main .table-scroll')
        .first()
        .innerHTML();
      const queried = await page.locator('.scope-strip').innerText();
      const documentToken = await page.evaluate(() => {
        const token = Math.random().toString();
        document.documentElement.dataset['loadingCheck'] = token;
        return token;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let intercepted!: () => void;
      const requested = new Promise<void>((resolve) => {
        intercepted = resolve;
      });
      const matcher = (url: URL) => url.searchParams.has('_rsc');
      await page.route(matcher, async (route) => {
        intercepted();
        await released;
        await route.continue();
      });
      try {
        await action();
        await Promise.race([
          requested,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Expected an RSC update request')),
              5000,
            ),
          ),
        ]);
        await page.getByRole('status').filter({ hasText: indicator }).waitFor();
        assert.equal(
          await skeleton.count(),
          0,
          'No skeleton replaces valid data during updates',
        );
        assert.equal(
          await page.locator('main .table-scroll').first().innerHTML(),
          before,
        );
        assert.equal(await page.locator('.scope-strip').innerText(), queried);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.dataset['loadingCheck'],
          ),
          documentToken,
          'No full document navigation',
        );
        release();
        await page
          .getByRole('status')
          .filter({ hasText: indicator })
          .waitFor({ state: 'hidden' });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.dataset['loadingCheck'],
          ),
          documentToken,
        );
      } finally {
        release();
        await page.unroute(matcher);
      }
    }
    await retainedUpdate(
      () => page.getByRole('button', { name: 'Refresh data' }).click(),
      'Updating snapshot',
    );
    await page.getByLabel('Status').selectOption('UNKNOWN');
    await retainedUpdate(
      () => page.getByRole('button', { name: 'Apply filters' }).click(),
      'Updating results',
    );
    assert.equal(new URL(page.url()).searchParams.get('status'), 'UNKNOWN');
    assert.equal(await page.getByLabel('Status').inputValue(), 'UNKNOWN');
    assert(
      (await page.locator('main table .status').allTextContents()).every(
        (value) => value.includes('UNKNOWN'),
      ),
    );
    await retainedUpdate(
      () => page.getByRole('link', { name: 'Clear', exact: true }).click(),
      'Updating results',
    );
    assert.equal(new URL(page.url()).searchParams.has('status'), false);
    assert.equal(await page.getByLabel('Status').inputValue(), '');

    // An empty filtered result is real content, never a lingering loader.
    await page.goto(sectionUrl('workers'));
    await page
      .getByLabel('Exact identifier')
      .fill('00000000-0000-4000-8000-000000000000');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page
      .getByText('No work matches this filter.', { exact: false })
      .waitFor();
    assert.equal(await skeleton.count(), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    console.log(
      'OPERATIONS_LOADING_BROWSER ' +
        JSON.stringify({
          metricHeightChange: Math.abs(
            loadingMetrics.height - loadedMetrics.height,
          ),
          screenshots: screenshotDir,
          initial: 'PASS',
          navigation: 'PASS',
          refresh: 'PASS',
          filters: 'PASS',
          reducedMotion: 'PASS',
          empty: 'PASS',
        }),
    );
  } catch (error) {
    await page.screenshot({ path: join(screenshotDir, 'failure.png') });
    throw error;
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
}
