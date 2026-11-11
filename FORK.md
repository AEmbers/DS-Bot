# AEmbers/DS-Bot

DS Bot 的独立维护 fork，上游 `Fei2411/DS-Bot`。

## 为什么 fork

上游 `ds-bot` 的 Bot↔Bot 消息**做不到实时打断**。表现是：`message_bot({when:'now'})`
本该在对方下一个 step 被读到，但实际要等对方当前那次模型调用跑完才收到。
一次编译、一次全量回归就是几十秒到十几分钟，于是「消息越排越多」，看起来像没在交流。

根因在 `ds-bot/src/host/steer.js`：切断判定四处写死 `source.kind === 'user'`，
而 Bot 消息的 `source.kind` 是 `'bot'`（`constants.js:41`），四处全部 false。
消息确实进了 `next-step` 队列，但没有人 `agent.cancel()`，只能等模型调用自然返回。

## 我们的改动

`f4609e4b feat(steer): let Bot messages cut a running model call`

| 文件 | 改了什么 |
|---|---|
| `ds-bot/src/host/steer.js` | 新增 `isCuttingSteer()`，四处判定统一改用它：用户消息照旧切，Bot 消息看 `source.steerCut === true` |
| `ds-bot/src/host/delivery.js` | `steer && role === 'request'` 时往 `source` 写 `steerCut: true` |
| `ds-bot/src/host/channel.js` | `case 'send'` 读 `body.mode`（只认严格 `'steer'`），`sendUser` 签名加 `mode` |
| `ds-bot/test/steer.test.js` | 新增 3 条 Bot steer 切断测试 + 负向对照说明 |

设计取舍：**不给所有 Bot 消息无条件切断**。`message_bot` 每次都走 steer 投递，
无条件切等于每次 Bot 说话都取消一次模型调用、白花一次 token。只在明确要求
「打断」时（`reply_to='me' && when='now'` → `steer=true && role='request'`）才写标记。

## 上游同步

`.github/workflows/sync-upstream.yml` 每天 04:00 Asia/Shanghai（cron `0 20 * * *` UTC）
自动 merge 上游 `main`，冲突时开 `upstream-sync` 标签的 issue。

**预期冲突文件**：`ds-bot/src/host/steer.js`、`ds-bot/src/host/delivery.js`。
`source.steerCut` 是我们的，上游没有。绝不能整边采纳 —— 采纳上游等于再次失去打断能力，
采纳我们的等于丢掉上游新增的投递字段。两边都要，然后重跑 `test/steer.test.js`。

## 本机安装说明

本机用的不是 npm 装的 `ds-bot`，而是 `~/.dsh/profiles/desktop/node_modules/ds-bot`
就地打补丁（与其它蓝屏加固补丁同一套做法）。补丁存
`C:\Users\Administrator\.dsh\bot\workspace\dsbot-patches\v032-steer\`，
升级上游后需重放。重放步骤见该目录的 README。

## 测试

```bash
cd ds-bot
npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps
export DSH_HARNESS="/path/to/DeepSeek Harness/resources/app/dsh"
node --import ./test/harness-resolve.mjs --test --test-timeout=120000 --test-force-exit "test/*.test.js"
```

不要用 junction 把已装包的 `node_modules` 链过来 —— 已装包只有 runtime 依赖，
缺 `esbuild`（44 个测试文件要用）和 `@xmldom/xmldom`。
