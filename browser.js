'use strict';

/**
 * 掘金部分接口在 Node 直连时常返回空 body（缺 a_bogus）。
 * 在真实 Chromium/Chrome 里发请求，由页面 SDK 自动补齐签名参数。
 */

const { chromium } = require('playwright');

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

function parseCookieHeader(cookieStr) {
  return cookieStr
    .split(/;\s*/)
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      return { name: pair.slice(0, i), value: pair.slice(i + 1) };
    })
    .filter((c) => c.name);
}

function buildPlaywrightCookies(cookieStr) {
  const pairs = parseCookieHeader(cookieStr);
  const cookies = [];
  for (const { name, value } of pairs) {
    cookies.push({ name, value, domain: '.juejin.cn', path: '/' });
  }
  const csrf = pairs.find((p) => p.name === 'csrf_session_id');
  if (csrf) {
    cookies.push({
      name: csrf.name,
      value: csrf.value,
      domain: 'api.juejin.cn',
      path: '/',
    });
  }
  return cookies;
}

function launchOptions() {
  const headless = String(process.env.PLAYWRIGHT_HEADLESS ?? 'true') !== 'false';
  if (process.env.PLAYWRIGHT_CHANNEL) {
    return { channel: process.env.PLAYWRIGHT_CHANNEL, headless };
  }
  if (process.env.CI) {
    return { headless };
  }
  return { channel: 'chrome', headless };
}

function pageUrlFor(apiPath) {
  if (String(apiPath).includes('lottery')) {
    return 'https://juejin.cn/user/center/lottery?from=lucky_lottery_menu_bar';
  }
  return 'https://juejin.cn/user/center/signin';
}

async function withBrowserPage(cookie, pageUrl, fn) {
  const browser = await chromium.launch(launchOptions());
  try {
    const context = await browser.newContext({
      userAgent: process.env.JUEJIN_UA || DEFAULT_UA,
      locale: 'zh-CN',
    });
    await context.addCookies(buildPlaywrightCookies(cookie));
    const page = await context.newPage();
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await new Promise((r) => setTimeout(r, 2500));
    const result = await fn(page);
    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}

async function pageApiCall(page, method, apiPath, body = {}) {
  return page.evaluate(
    async ({ method, apiPath, body }) => {
      const url = `https://api.juejin.cn${apiPath}?aid=2608&spider=0`;
      const headers = {};
      let init = { method, credentials: 'include', headers };

      if (method !== 'GET') {
        const head = await fetch(url, {
          method: 'HEAD',
          credentials: 'include',
          headers: {
            'x-secsdk-csrf-request': '1',
            'x-secsdk-csrf-version': '1.2.22',
          },
        });
        const csrfRaw = head.headers.get('X-Ware-Csrf-Token') || '';
        const token = csrfRaw.split(',')[1] || '';
        headers['content-type'] = 'application/json';
        if (token) headers['x-secsdk-csrf-token'] = token;
        init.body = JSON.stringify(body ?? {});
      }

      const res = await fetch(url, init);
      const text = await res.text();
      if (!text) {
        return {
          httpStatus: res.status,
          err_no: -2,
          err_msg: 'empty_body',
          data: null,
          empty: true,
          via: 'playwright',
        };
      }
      try {
        return {
          httpStatus: res.status,
          empty: false,
          via: 'playwright',
          ...JSON.parse(text),
        };
      } catch {
        return {
          httpStatus: res.status,
          err_no: -1,
          err_msg: text.slice(0, 200),
          data: null,
          empty: true,
          via: 'playwright',
        };
      }
    },
    { method, apiPath, body }
  );
}

/**
 * @param {string} cookie
 * @param {string} apiPath
 * @param {object} [body]
 */
async function browserApiPost(cookie, apiPath, body = {}) {
  return withBrowserPage(cookie, pageUrlFor(apiPath), (page) =>
    pageApiCall(page, 'POST', apiPath, body)
  );
}

/**
 * @param {string} cookie
 * @param {string} apiPath
 */
async function browserApiGet(cookie, apiPath) {
  return withBrowserPage(cookie, pageUrlFor(apiPath), (page) =>
    pageApiCall(page, 'GET', apiPath)
  );
}

/**
 * 在同一次浏览器会话内完成：查配置 → 有免费次数则抽奖 → 查幸运值
 * @param {string} cookie
 */
async function browserFreeLottery(cookie) {
  return withBrowserPage(
    cookie,
    'https://juejin.cn/user/center/lottery?from=lucky_lottery_menu_bar',
    async (page) => {
      const cfg = await pageApiCall(
        page,
        'GET',
        '/growth_api/v1/lottery_config/get'
      );
      if (cfg.err_no !== 0) {
        return {
          ok: false,
          lotteryMsg: `抽奖配置失败: ${cfg.err_msg || cfg.err_no}`,
          freeCount: null,
          luckyValue: null,
          cfg,
          draw: null,
        };
      }

      const freeCount = cfg.data?.free_count ?? 0;
      let lotteryMsg = '';
      let draw = null;
      let prize = null;

      if (freeCount <= 0) {
        lotteryMsg = '今天没有抽奖次数了';
      } else {
        draw = await pageApiCall(
          page,
          'POST',
          '/growth_api/v1/lottery/draw',
          {}
        );
        if (draw.err_no === 0) {
          prize = draw.data?.lottery_name || '未知奖品';
          lotteryMsg = prize;
        } else if (draw.empty) {
          lotteryMsg = '抽奖失败（接口空响应/风控）';
        } else {
          lotteryMsg = `抽奖失败: ${draw.err_msg || draw.err_no}`;
        }
      }

      // 幸运值：优先用抽奖响应，否则查 my_lucky
      let luckyValue =
        draw?.data?.total_lucky_value ??
        draw?.data?.draw_lucky_value ??
        null;
      if (luckyValue == null) {
        const lucky = await pageApiCall(
          page,
          'POST',
          '/growth_api/v1/lottery_lucky/my_lucky',
          {}
        );
        if (lucky.err_no === 0) {
          luckyValue = lucky.data?.total_value ?? null;
        }
      }

      // 页面展示形如 4098/6000；上限多在前端，优先从 DOM 读取
      const progress = await page.evaluate(() => {
        const el =
          document.querySelector('.value-wrap') ||
          document.querySelector('.lucky-progress-wrap') ||
          document.querySelector('.progress-wrap');
        const text = (el?.innerText || '').replace(/\s+/g, '');
        const m = text.match(/(\d+)\/(\d+)/);
        if (!m) return null;
        return { current: Number(m[1]), max: Number(m[2]) };
      });
      const luckyMax = progress?.max ?? 6000;
      if (luckyValue == null && progress?.current != null) {
        luckyValue = progress.current;
      }
      const luckyProgress =
        luckyValue != null ? `${luckyValue}/${luckyMax}` : null;

      return {
        ok: freeCount <= 0 || draw?.err_no === 0,
        lotteryMsg,
        freeCount,
        prize,
        luckyValue,
        luckyMax,
        luckyProgress,
        cfg,
        draw,
      };
    }
  );
}

module.exports = {
  browserApiPost,
  browserApiGet,
  browserFreeLottery,
};
