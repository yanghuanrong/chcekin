# 掘金每日签到

通过 Cookie 调用掘金成长 API 完成每日签到，可选免费抽奖，并通过钉钉机器人推送结果。支持本地运行与 GitHub Actions。

## 功能

- 查询今日签到状态（`get_today_status`）
- 签到（`check_in`）；**今日已签到（err_no=15001）视为成功**
- 查询当前矿石 / 连续天数
- 幸运抽奖页免费抽奖（`lottery_config/get` + `lottery/draw`）
- 钉钉 Markdown 通知（支持加签）
- GitHub Actions 定时 / 手动触发

## 本地运行

```bash
cp .env.example .env
# 编辑 .env，填入 JUEJIN_COOKIE（及可选钉钉配置）
npm install
npm start
```

要求：

- Node.js >= 18
- 本机已安装 **Google Chrome**（签到/抽奖写接口会走 Playwright，自动带上 `a_bogus` 等风控参数）

> 纯 HTTP 调用 `check_in` 常返回空 body；脚本会自动回退到浏览器上下文重试。

成功时 stdout 会打印摘要 + JSON，`status` 为 `success` 或 `already` 时进程退出码为 `0`。

## 如何获取 Cookie

1. Chrome 登录 [掘金](https://juejin.cn)
2. DevTools → **Application** → **Cookies**
3. 复制 `juejin.cn` 与 `api.juejin.cn` 下相关 Cookie（至少 `sessionid`、`sid_guard`，建议含 `csrf_session_id`）
4. 拼成一行写入 `JUEJIN_COOKIE`

也可在 Network 面板任选 `api.juejin.cn` 请求，从 Request Headers 的 `cookie` 复制。

> Cookie 会过期；失效后重新复制并更新本地 `.env` / GitHub Secrets。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `JUEJIN_COOKIE` | 是 | 掘金登录 Cookie |
| `DINGTALK_WEBHOOK` | 否 | 钉钉机器人 Webhook |
| `DINGTALK_SECRET` | 否 | 钉钉加签密钥 |
| `ENABLE_LOTTERY` | 否 | 是否尝试免费抽奖，默认 `true` |
| `FORCE_BROWSER` | 否 | `true` 时写接口直接走 Playwright |
| `PLAYWRIGHT_CHANNEL` | 否 | 本地默认 `chrome`；CI 不设则用自带 Chromium |

## 钉钉机器人

1. 钉钉群 → 添加「自定义」机器人
2. 若开启加签，同时配置 `DINGTALK_SECRET`
3. Webhook 写入 `DINGTALK_WEBHOOK`

## GitHub Actions

Workflow：`.github/workflows/daily-checkin.yml`

- `schedule`: UTC `50 1 * * *`（北京时间 **每天 09:50**；GitHub 定时可能有几分钟延迟）
- `workflow_dispatch`: 可手动触发
- 会安装 Playwright Chromium（用于绕过签到写接口风控）

Secrets：

- `JUEJIN_COOKIE`（必填）
- `DINGTALK_WEBHOOK`（建议）
- `DINGTALK_SECRET`（加签时）
- `DINGTALK_KEYWORD`（可选，默认脚本内为「掘金」）

## API（Playwright 抓包确认）

| 用途 | Method | URL |
|------|--------|-----|
| 今日状态 | GET | `https://api.juejin.cn/growth_api/v2/get_today_status?aid=2608&spider=0` |
| 签到 | POST | `https://api.juejin.cn/growth_api/v1/check_in?aid=2608&spider=0` |
| 当前矿石 | GET | `https://api.juejin.cn/growth_api/v1/get_cur_point?aid=2608&spider=0` |
| 签到统计 | GET | `https://api.juejin.cn/growth_api/v1/get_counts?aid=2608&spider=0` |
| 抽奖配置 | GET | `https://api.juejin.cn/growth_api/v1/lottery_config/get?aid=2608&spider=0` |
| 抽奖 | POST | `https://api.juejin.cn/growth_api/v1/lottery/draw?aid=2608&spider=0` |

必要请求头：`cookie`、`referer: https://juejin.cn/`、`user-agent`；写接口（签到/抽奖）会先 `HEAD` 取 `X-Ware-Csrf-Token`，再带 `x-secsdk-csrf-token`。

响应示例（脱敏）：

```json
// 今日状态
{"err_no":0,"err_msg":"success","data":{"check_in_done":true,"lt_task_exist":false,"extra":null}}

// 今日已签到
{"err_no":15001,"err_msg":"您今日已完成签到，请勿重复签到","data":null}

// 签到成功（结构示例）
{"err_no":0,"err_msg":"success","data":{"incr_point":7,"sum_point":16429,"cont_count":2,"sum_count":388}}
```

## 风险说明

- 浏览器内 fetch 会被 SDK 自动附加 `msToken` / `a_bogus`；纯 Node POST 有时返回空 body。
- 脚本以 `get_today_status.check_in_done` 与 `err_no=15001` 判定「已签到成功」。
- 若未签到且 POST 空响应，可临时从浏览器 Network 复制 `msToken`/`a_bogus`，或更新 Cookie 后重试。
- 勿将真实 Cookie / Webhook 提交到 Git（已在 `.gitignore` 忽略 `.env`）。
