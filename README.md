# pi-auto-title

为 Pi 新会话自动生成简洁、可检索的原生标题。只处理首轮，不做分类、收藏或同步。

> 第一轮正常回答完成后，独立请求你选择的标题模型。标题提示词和模型回复都不进入主对话上下文。不使用 subagent，不修改 Pi 本体。

## 标题效果

| 首条问题 | 期望标题示例 |
| --- | --- |
| frp是什么，能用来做内网穿透吗？ | frp内网穿透工具简介 |
| 帮我把PLC复习试卷整理成PDF | PLC复习试卷PDF整理 |
| 杭州和上海的两个实习岗位怎么选？ | 杭州与上海实习岗位对比 |
| 开发一个Pi自动会话标题扩展 | Pi会话自动命名扩展开发 |

标题跟随用户语言，保留技术名词。中文建议 8～20 字，所有标题最多 30 个 Unicode 码点。不通过截取问题伪装成摘要；模型输出不合格时保留无标题。示例是风格目标，不是实时模型质量测试结果。

## 兼容性

- 使用 `@earendil-works/pi-coding-agent` **1.5.0** 的实际 SDK 开发和测试。
- 必须支持 `agent_settled`、`session_info_changed`、`session_shutdown` 和 `modelRegistry.streamSimple`。
- 未承诺兼容不具备这些接口的旧 Pi 或其他分支。
- 开发与测试使用 Node.js 24；扩展没有额外的运行时 npm 依赖。

## 安装

先检查源码，再安装固定版本：

```sh
pi install git:github.com/kongzhuww/pi-auto-title@v0.1.0
```

在已打开的 Pi 中执行 `/reload`，或重新启动 Pi。

也可从本地源码安装：

```sh
git clone https://github.com/kongzhuww/pi-auto-title.git
cd pi-auto-title
pi install .
```

不需要为运行扩展执行 `npm install`；Pi 提供 SDK 并加载 TypeScript。不要同时用多个来源安装同一扩展。

## 唯一命令

```text
/auto-title model
```

使用 Pi 原生选择器，从已配置认证的聊天模型中选择专用标题模型。支持 Esc 取消。选择 `Disabled (no title requests)` 可关闭自动标题。

- **默认关闭**：未选择模型之前不发送标题请求，也不自动退回主模型。
- 独立使用选中的 provider/model ID，**不会改变主对话模型**。
- 使用 Pi 自己的 provider、认证、OAuth 和模型注册表，不要求重新填写 Key。
- 不硬编码 Gemini 型号。想使用 Gemini 时，选本机 Pi 列表中的准确条目即可。
- 标题模型与主模型的 scoped-model 列表独立；选择器列出所有具备认证的聊天模型。
- 改动立即保存；本实例中正在进行的旧标题请求会被取消。
- 建议先选模型，再用 `/new` 开始正常对话。配置模型不会回填已结束的会话。

按当前第一版范围，只提供这一个配置入口：**没有手动生成、重新生成或批量命令**。已有名称一律不覆盖；需要手动命名时使用 Pi 自带的 `/name`。

## 工作流程

```text
首条真实用户输入（展开前）
    -> 主对话正常回答
    -> agent_settled，检查未中止且有有效最终回答
    -> 独立后台标题请求
    -> 核对会话身份、实例、名称与名称修订记录
    -> pi.setSessionName(title)
```

- 只在新会话首轮消费一次机会。失败、取消、无配置或无有效回答后，不在后续轮次补发。
- 用 `pi.appendEntry()` 记录一次性标记；标记不进入模型上下文，不保存问题或回答副本。
- 已经有历史、已恢复、分叉或曾经改名的会话不自动处理。空白会话的 `/reload` 不妨碍尚未开始的首轮。
- `agent_end` 不是最终结束信号；自动重试和工具调用完成后才在 `agent_settled` 判断。
- 中止、最终错误、截断、仅工具调用、只有思考或空回答都会跳过。
- 首轮夹入 steering/follow-up 或多个用户消息时，保守跳过，避免错配问题和回答。
- 标题请求不被事件处理器等待，不阻塞下一轮主对话。
- 10 秒整体截止时间；传递 AbortSignal 和 HTTP 超时，设置 `maxRetries: 0`，扩展不重试。
- 切换、退出、重载、树导航、请求期间改名（包括改名后又清空）时丢弃结果。
- 不直接编辑 JSONL，不重命名会话文件。

## 隐私、请求与费用

每个成功进入生成阶段的会话额外调用一次所选标题模型；消耗该 provider 的额度或费用，订阅是否覆盖由服务商决定。

标题请求包含：

- 扩展自己的固定标题指令；
- 首条用户问题的前 **2,000** 个 Unicode 码点；
- 首轮最终助手回答可见文字的前 **3,000** 个 Unicode 码点。

不附带工具结果消息、工具参数、思考块、图片、系统提示、Skills 正文、压缩摘要或完整历史。主对话中的其他扩展如果提前改写 `input`，本扩展只能看到当时 SDK 提供的输入；助手最终可见回答本身若引用敏感内容，该部分仍可能随有限文字发送。**这不是通用脱敏器。**

不会向主对话追加任何标题请求或回复，也不会把 provider 原始错误写到日志。标题请求的用量目前不计入 Pi 主对话的 token/费用统计，请以 provider 账单为准。

取消尽力停止底层请求；自定义 provider 若不遵守取消或重试选项，扩展仍会丢弃晚到结果，但无法保证停止服务端计算或计费。多进程同时操作同一会话文件不提供跨进程事务或锁。

## 配置位置与示例

通过 Pi 的 `getAgentDir()` 获取当前配置环境，保存为该目录下的 `auto-title.json`。不会写入代码仓库、认证文件或主配置文件。

通常为 `~/.pi/agent/auto-title.json`；使用 `PI_CODING_AGENT_DIR` 时跟随该环境，互不串用。

```json
{
  "version": 1,
  "model": {
    "provider": "your-configured-provider",
    "modelId": "exact-model-id-from-pi"
  }
}
```

上面是占位示例，不是可直接使用的型号。实际推荐通过命令选择，不手输模型名。关闭时 `model` 为 `null`。损坏或不支持的配置会跳过生成，不换模型。

## 卸载

```sh
pi remove git:github.com/kongzhuww/pi-auto-title@v0.1.0
```

随后 `/reload` 或重启。若按本地路径安装，使用 `pi remove <当时安装的本地绝对路径>`。

可自行删除当前配置目录中的 `auto-title.json`。已经生成的原生名称及扩展一次性标记留在原会话中，不自动改名或清理会话文件。

## 开发与测试

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

测试不使用真实凭据或付费模型：

- 单元与生命周期测试：一次性、恢复/重载、手动改名、身份和元数据二次核查、失败、超时、忽略取消的 provider、模型配置隔离。
- 真实 SDK 集成：实际加载入口、实际首轮事件、独立请求、原生名称持久化、恢复不重复。模型仅由测试中的本机回环 HTTP 服务模拟。
- GitHub Actions 在 Windows 和 Ubuntu / Node.js 24 上执行相同检查。

要使用另一套本机 SDK 重跑集成测试，可设置 `PI_AUTO_TITLE_TEST_SDK` 为其 `dist/index.js` 的绝对路径，然后执行 `node --test tests/sdk.test.ts`。

设计与来源见 [docs/design.md](docs/design.md)。

## License

MIT.
