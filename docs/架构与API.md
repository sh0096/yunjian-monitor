# 架构与网页 API

## 数据路径

```text
浏览器 ── HTTPS / 管理会话 ── 自有 Node.js 后端 ── TGT / WSKEY ── 固定京东网关
                                     │
                             本机 SQLite + 加密凭据
                                     │
                             定时在线备份（不含密钥）
```

前端负责展示，后端完成签名与持续采集。浏览器关闭后后端仍按约 5 秒周期运行；网页隐藏时暂停自己的查询。管理会话与平台凭据分开，网页不会回读已保存的 TGT / WSKEY。

`server/jd.mjs` 适配固定平台路径，仅发送 `get_router_status_detail` 状态查询，未开放设备重启、解绑或任意命令。网关路径名 `controlDevice` 不代表本网页开放设备控制。

每个账户有单独任务锁与截止时间。状态每轮更新，设备列表和收益复用各自缓存；平台限流和鉴权失败进入暂停状态。

## 存储

| 表 | 用途 | 保留 |
|---|---|---|
| `accounts` | 账户备注、加密凭据、采集状态 | 删除账户前 |
| `snapshots` | 每分钟最后一次完整快照与最新状态 | 7 天 |
| `fast_samples` | 逐次带宽采样 | 2 小时 |
| `minute_samples` | 每分钟有效读数均值、峰值与计数 | 7 天 |
| `daily_earnings` | 实际观测日期的入账积分 | 90 天，API 返回最近 30 个已记录日期 |
| `sessions` | 散列后的管理会话与 CSRF | 12 小时 |
| `settings` | 管理密码散列、备份检查状态 | 长期 |

`uploadBps/downloadBps` 的历史命名沿用早期实现，实际为 **bit/s**，不是 byte/s。原始状态值乘 1024 得到内部速率；展示时除 8 并按 1024 进位。缺失、离线和请求失败保留未知值，不当作零上传。

## 网页 API

除健康检查、演示和登录流程外，以下接口都要求 `yj_session` 管理 Cookie。没有第三方公开读数接口。所有修改请求校验 `Origin`，登录后的修改还需 `X-CSRF-Token`。

| 方法与路径 | 用途 |
|---|---|
| `GET /healthz` | 基础健康检查，不含账户信息 |
| `GET /api/demo` | 生成的示例快照与曲线 |
| `GET /api/session` | 登录状态、CSRF、采样周期与运行模式 |
| `POST /api/setup` | 仅开发模式回环首次设置管理密码 |
| `POST /api/login` | 管理登录，成功时设置 HttpOnly Cookie |
| `POST /api/logout` | 注销当前管理会话 |
| `GET /api/accounts` | 账户状态、最新快照、每日入账及备份检查状态 |
| `POST /api/accounts` | 验证并接入账户，JSON 字段为 `label/tgt/wskey` |
| `PUT /api/accounts/:id` | 验证并替换凭据 |
| `DELETE /api/accounts/:id` | 删除账户、凭据及关联历史 |
| `GET /api/accounts/:id/history?hours=1` | 曲线，范围仅支持 `0.5/1/6/24` 小时 |
| `POST /api/accounts/:id/refresh` | 在采集间隔允许时触发状态查询 |

同一 TGT 重复接入会返回已有账户，避免重复统计；并发接入也做同样检查。`history` 不带 `hours` 时返回原有分钟快照，作为旧版兼容路径。带范围时会标记 `sample`、`minute` 或 `legacy-minute` 的记录精度。

响应示例（数值与标识为生成数据）：

```json
{
  "resolution": "sample",
  "history": [{
    "at": 1792152000000,
    "resolution": "sample",
    "devices": [{
      "id": "example-device",
      "online": true,
      "statusAt": 1792152000000,
      "uploadBps": 8388608,
      "downloadBps": 8192
    }]
  }]
}
```

## 登录态与错误

TGT / WSKEY 生命周期由平台决定，本项目没有可核实的自动续期协议。HTTP 401 暂停并等待替换凭据；403 表示拒绝访问，429 表示限流。不能把所有业务错误或结构变化均解释为过期。

适配器明确校验响应类型、分页完整性和设备 ID；64 位数字型 `feed_id` 使用 Node.js 24 的 JSON reviver 原始 token 保留，避免 JavaScript 数字精度损失。响应无法识别时停止使用该数据，并显示核查提示。
