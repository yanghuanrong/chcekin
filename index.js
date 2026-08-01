'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { browserApiPost, browserFreeLottery } = require('./browser');

loadEnv(path.join(__dirname, '.env'));

const BASE = 'https://api.juejin.cn';
const AID = '2608';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/** 掘金「今日已签到」业务码 */
const ERR_ALREADY_CHECKIN = 15001;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      try {
        val = JSON.parse(val.startsWith('"') ? val : `"${val.slice(1, -1)}"`);
      } catch {
        val = val.slice(1, -1);
      }
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function extractUuid(cookie) {
  const m = cookie.match(/__tea_cookie_tokens_2608=([^;]+)/);
  if (!m) return '';
  try {
    let raw = decodeURIComponent(m[1]);
    if (raw.includes('%')) raw = decodeURIComponent(raw);
    return JSON.parse(raw).web_id || '';
  } catch {
    return '';
  }
}

function buildUrl(apiPath, extra = {}) {
  const params = new URLSearchParams({ aid: AID, spider: '0' });
  const uuid = process.env.JUEJIN_UUID || extra.uuid || '';
  if (uuid) params.set('uuid', uuid);
  if (extra.msToken) params.set('msToken', extra.msToken);
  if (extra.a_bogus) params.set('a_bogus', extra.a_bogus);
  return `${BASE}${apiPath}?${params.toString()}`;
}

function baseHeaders(cookie, extra = {}) {
  return {
    cookie,
    'user-agent': UA,
    referer: 'https://juejin.cn/',
    origin: 'https://juejin.cn',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...extra,
  };
}

async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text) {
    return {
      httpStatus: res.status,
      err_no: -2,
      err_msg: 'empty_body',
      data: null,
      empty: true,
    };
  }
  try {
    return { httpStatus: res.status, empty: false, ...JSON.parse(text) };
  } catch {
    return {
      httpStatus: res.status,
      err_no: -1,
      err_msg: text.slice(0, 200),
      data: null,
      empty: true,
    };
  }
}

async function apiGet(cookie, apiPath) {
  const res = await fetch(buildUrl(apiPath, { uuid: extractUuid(cookie) }), {
    method: 'GET',
    headers: baseHeaders(cookie),
  });
  return parseJsonResponse(res);
}

/** POST 写接口需要 secsdk CSRF：先 HEAD 取 X-Ware-Csrf-Token */
async function getCsrfToken(cookie, apiPath) {
  const res = await fetch(buildUrl(apiPath, { uuid: extractUuid(cookie) }), {
    method: 'HEAD',
    headers: baseHeaders(cookie, {
      'x-secsdk-csrf-request': '1',
      'x-secsdk-csrf-version': '1.2.22',
    }),
  });
  const raw = res.headers.get('x-ware-csrf-token') || '';
  // 格式: code,token,ttl,status,csrf_session_id
  const parts = raw.split(',');
  return parts[1] || '';
}

async function apiPostHttp(cookie, apiPath, body = {}) {
  const csrf = await getCsrfToken(cookie, apiPath);
  const extra = { uuid: extractUuid(cookie) };
  if (process.env.JUEJIN_MS_TOKEN) extra.msToken = process.env.JUEJIN_MS_TOKEN;
  if (process.env.JUEJIN_A_BOGUS) extra.a_bogus = process.env.JUEJIN_A_BOGUS;

  const headers = baseHeaders(cookie, {
    'content-type': 'application/json',
  });
  if (csrf) headers['x-secsdk-csrf-token'] = csrf;

  const res = await fetch(buildUrl(apiPath, extra), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return parseJsonResponse(res);
}

/** 写接口：HTTP 空响应时自动用 Playwright 浏览器上下文重试（绕过 a_bogus 风控） */
async function apiPost(cookie, apiPath, body = {}) {
  const forceBrowser = String(process.env.FORCE_BROWSER ?? '') === 'true';
  if (!forceBrowser) {
    const httpResp = await apiPostHttp(cookie, apiPath, body);
    if (!httpResp.empty) return { ...httpResp, via: 'http' };
    console.log(`[warn] ${apiPath} HTTP 返回空响应，改用 Playwright 重试…`);
  } else {
    console.log(`[info] FORCE_BROWSER=true，直接用 Playwright 调用 ${apiPath}`);
  }
  return browserApiPost(cookie, apiPath, body);
}

function isAuthError(resp) {
  const msg = String(resp.err_msg || '');
  return (
    resp.err_no === 403 ||
    resp.httpStatus === 401 ||
    resp.httpStatus === 403 ||
    /must login|未登录|请重新登录/i.test(msg)
  );
}

function isAlreadyCheckedIn(resp, today) {
  if (resp && resp.err_no === ERR_ALREADY_CHECKIN) return true;
  if (today && today.err_no === 0 && today.data?.check_in_done) return true;
  return false;
}

async function notifyDingTalk(markdown) {
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook) {
    return { skipped: true };
  }
  let url = webhook;
  const secret = process.env.DINGTALK_SECRET;
  if (secret) {
    const timestamp = String(Date.now());
    const sign = encodeURIComponent(
      crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${secret}`)
        .digest('base64')
    );
    url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: '掘金签到', text: markdown },
    }),
  });
  return res.json().catch(() => ({}));
}

function nowStr() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** 拉取矿石 + 连续/累计签到天数（页面「连续签到」同源接口 get_counts） */
async function fetchPointAndCounts(cookie) {
  const [point, counts] = await Promise.all([
    apiGet(cookie, '/growth_api/v1/get_cur_point'),
    apiGet(cookie, '/growth_api/v1/get_counts'),
  ]);
  return {
    sumPoint: point.err_no === 0 ? point.data : null,
    contCount:
      counts.err_no === 0 && counts.data != null
        ? counts.data.cont_count
        : null,
    sumCount:
      counts.err_no === 0 && counts.data != null
        ? counts.data.sum_count
        : null,
  };
}

function printSummary(result) {
  const lines = [
    '======== 掘金签到 ========',
    `状态      : ${result.statusLabel}`,
    result.incrPoint != null ? `本次矿石  : +${result.incrPoint}` : null,
    result.sumPoint != null ? `当前矿石  : ${result.sumPoint}` : null,
    result.contCount != null ? `连续签到  : ${result.contCount} 天` : null,
    result.sumCount != null ? `累计签到  : ${result.sumCount} 天` : null,
    `抽奖      : ${result.lotteryMsg || '-'}`,
    `幸运值    : ${result.luckyProgress || (result.luckyValue != null ? String(result.luckyValue) : '-')}`,
    `时间      : ${result.time}`,
    '==========================',
  ].filter(Boolean);
  console.log(lines.join('\n'));
}

async function main() {
  const cookie = process.env.JUEJIN_COOKIE;
  if (!cookie) {
    console.error('缺少环境变量 JUEJIN_COOKIE');
    process.exitCode = 1;
    await notifyDingTalk(
      `### 掘金签到失败\n\n- **状态**: 配置缺失\n- **消息**: 缺少 JUEJIN_COOKIE\n- **时间**: ${nowStr()}`
    );
    return;
  }

  if (!process.env.JUEJIN_UUID) {
    const uuid = extractUuid(cookie);
    if (uuid) process.env.JUEJIN_UUID = uuid;
  }

  const enableLottery = String(process.env.ENABLE_LOTTERY ?? 'true') !== 'false';

  let status = 'unknown';
  let message = '';
  let incrPoint = null;
  let sumPoint = null;
  let contCount = null;
  let sumCount = null;
  let lotteryMsg = '';
  let luckyValue = null;
  let luckyProgress = null;
  let raw = null;

  try {
    const today = await apiGet(cookie, '/growth_api/v2/get_today_status');
    raw = today;

    if (isAuthError(today)) {
      status = 'auth_failed';
      message = today.err_msg || 'Cookie 无效或已过期';
    } else if (isAlreadyCheckedIn(null, today)) {
      // 今日已签到：直接拉矿石/天数，不再打 check_in（避免无意义的风控重试）
      status = 'already';
      message = '今日已签到';
      raw = today;
      ({ sumPoint, contCount, sumCount } = await fetchPointAndCounts(cookie));
    } else {
      const result = await apiPost(cookie, '/growth_api/v1/check_in', {});
      raw = result;
      if (result.err_no === 0) {
        status = 'success';
        message = result.err_msg || '签到成功';
        incrPoint = result.data?.incr_point ?? null;
        sumPoint = result.data?.sum_point ?? null;
        contCount = result.data?.cont_count ?? null;
        sumCount = result.data?.sum_count ?? null;
        // 签到响应若缺连续天数，再补拉 get_counts
        if (contCount == null || sumCount == null || sumPoint == null) {
          const extra = await fetchPointAndCounts(cookie);
          sumPoint = sumPoint ?? extra.sumPoint;
          contCount = contCount ?? extra.contCount;
          sumCount = sumCount ?? extra.sumCount;
        }
      } else if (result.err_no === ERR_ALREADY_CHECKIN) {
        status = 'already';
        message = result.err_msg || '今日已签到';
        ({ sumPoint, contCount, sumCount } = await fetchPointAndCounts(cookie));
      } else if (isAuthError(result)) {
        status = 'auth_failed';
        message = result.err_msg || 'Cookie 无效或已过期';
      } else if (result.empty) {
        status = 'failed';
        message =
          '签到接口返回空响应（可能触发风控，需 msToken/a_bogus 或更新 Cookie）';
      } else {
        status = 'failed';
        message = result.err_msg || `签到失败 err_no=${result.err_no}`;
      }
    }

    if (enableLottery && (status === 'success' || status === 'already')) {
      // lottery_config/get、lottery/draw 直连易空响应，统一走抽奖页浏览器会话
      const lottery = await browserFreeLottery(cookie);
      lotteryMsg = lottery.lotteryMsg || '';
      luckyValue = lottery.luckyValue ?? null;
      luckyProgress = lottery.luckyProgress ?? null;
      if (lottery.draw?.err_no === 0) {
        // 抽中矿石后刷新矿石余额
        const extra = await fetchPointAndCounts(cookie);
        if (extra.sumPoint != null) sumPoint = extra.sumPoint;
      }
    } else if (!enableLottery) {
      lotteryMsg = '已关闭抽奖';
    }
  } catch (err) {
    status = 'error';
    message = err.message || String(err);
    raw = { err_no: -1, err_msg: message };
  }

  const statusLabel = {
    success: '签到成功',
    already: '今日已签到',
    auth_failed: 'Cookie 失效',
    failed: '签到失败',
    error: '网络/运行错误',
    unknown: '未知',
  }[status];

  const result = {
    status,
    statusLabel,
    message,
    incrPoint,
    sumPoint,
    contCount,
    sumCount,
    lotteryMsg,
    luckyValue,
    luckyProgress,
    raw,
    time: nowStr(),
  };
  printSummary(result);

  const md = [
    '### 掘金签到结果',
    '',
    `- **状态**: ${statusLabel}`,
    incrPoint != null ? `- **本次积分**: +${incrPoint}` : null,
    sumPoint != null ? `- **当前矿石**: ${sumPoint}` : null,
    contCount != null ? `- **连续签到**: ${contCount} 天` : null,
    sumCount != null ? `- **累计签到**: ${sumCount} 天` : null,
    lotteryMsg ? `- **抽奖**: ${lotteryMsg}` : null,
    luckyProgress || luckyValue != null
      ? `- **幸运值**: ${luckyProgress || luckyValue}`
      : null,
    `- **时间**: ${nowStr()}`,
  ]
    .filter(Boolean)
    .join('\n');

  await notifyDingTalk(md);

  // 已签到 / 签到成功 → 成功退出；仅鉴权失败、真正失败、异常才非 0
  if (status === 'auth_failed' || status === 'failed' || status === 'error') {
    process.exitCode = 1;
  }
}

main();
