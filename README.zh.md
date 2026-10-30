# perse-cua

[English](README.md) | 中文

`perse` = persevere

把 [cua-driver](https://github.com/trycua/cua) 的桌面自动化工具交给 DSH 的模型，
但不再为一次会话根本用不到的部分付费。

**Part of Persevere with DSH**

-----

macOS 14 及以上默认使用实验性的 DSH 原生执行器。它会请求逐应用授权，并要求宿主提供 DSH 0.2.1-rc.2 服务；预览在操作后捕获已授权窗口，不会改变模型使用的截图坐标；原生 GUI、授权和光标的完整体验尚未验收。下文有关驱动的测量和行为适用于 `backend: mcp`。

已有 macOS 配置若设置了 `command`、`args`、`allow`、`indicator` 等 MCP 专属选项，须增加 `backend: mcp`；否则启动会报错，不会静默切回外部驱动。已加载原生执行器的配置档案可设置 `presenterOnly: true` 以提供预览服务；自动原生预览要求本插件管理执行器及其授权生命周期。

## 它解决什么

cua-driver 0.28.1 对外声明 **56 个工具**。不管这一轮任务碰不碰图形界面，这 56 个定义都会
挂在**每一次**模型请求上。在发布版驱动上实测：

| | 工具数 | 模型可见 schema | ≈ 每请求 token |
| --- | --- | --- | --- |
| 裸用 `@deepseek-ai/dsh-mcp-client` | 56 | 95.1 KB | ~24,300 |
| 经过 `perse-cua`（默认） | 53 | 61.7 KB | ~15,800（**−35%**） |

而当任务真的在操作 app 时，原始窗口快照里绝大部分是菜单栏：在一个 230×408 的计算器窗口上，
菜单子树占 146 个元素中的 145 个、占渲染字节的 **88%**。它永远不可能是操作目标 —— 菜单项要用
`invoke_menu` 按路径走 —— 所以它纯粹是干扰定位的噪音。

## 它做什么

1. **把描述压缩到首句** —— 默认省下来的部分主要来自这里。完整操作手册并没有丢：它本来就以
   `cua-driver` 技能的形式随包发布，模型需要时按需加载。参数 schema 原样透传，所以每个工具
   仍然正常校验。
2. **只拒绝能证明是废料的工具。** `bestExperience` 开启（默认）时，默认 `deny` 只剩 3 个
   不可能改变任务结果的工具：`check_for_update` 探测，以及两个已废弃的兼容 shim
   （`escalate_session`、`get_session_state`）。设 `bestExperience: false` 可把 4 个
   `*_agent_cursor_*` 工具也加回拒绝列表，恢复旧的工具面。其余驱动声明的工具全部到达模型。
3. **剥掉 AX 菜单栏子树**，窗口块保持逐字节不变 —— 包括原有的元素编号，因为 `element_token`
   必须继续对得上驱动缓存的那份快照。
4. **默认开启 macOS MCP 最佳体验**：插件启动时打开一个命名驱动会话（默认标签 `perse-cua`）并
   显示**可见的 agent 光标** —— 就是 Codex 那种效果：你看着一个光标在后台窗口里干活，而你的
   鼠标、键盘焦点和最前台的 app 全都不受影响。四个 `*_agent_cursor_*` 工具保留在模型面前，
   模型可以随时换主题、调动效或隐藏光标。驱动不接受调用时降级为"光标不显示"，启动绝不失败。

### 为什么默认这么保守

早先一版按手写的"桌面自动化闭环"白名单裁剪，报告了 58% 的节省。那多出来的 21 个点里
**大部分是砍能力，不是去废料** —— 它删掉了网页自动化、轨迹回放、会话生命周期和真实指针，
却把总数当作效率成果汇报。按正确的拆分实测：

| 策略 | 工具数 | schema | ≈ token | 能力 |
| --- | --- | --- | --- | --- |
| 只压缩描述 | 56 | 62.7 KB | ~16,000 | 完整 |
| **默认：压缩 + 去废料** | **53** | **61.7 KB** | **~15,800** | **完整** |
| 压缩 + `MINIMAL_ALLOW`（自动并回光标工具） | 31 | ~41.5 KB | ~10,700 | 仅桌面 |

"只压缩描述"那一行才是真正免费的诚实上限。白名单是**能力上限**：不在名单里的工具对模型是
**不可见**，而不只是未被使用 —— 模型要不到它看不见的东西。

如果请求体积比覆盖面更重要，显式选择激进裁剪：

```yaml
- id: perse-cua
  config:
    allow: !!js (await import('perse-cua')).MINIMAL_ALLOW
```

## 使用

`perse-cua` 自带 `dsh.bundle.patch`，所以装上它就已经注册了 loader 行。你只需要加一条
**config 覆盖** —— 不要写第二条 `insert`，那会撞 loader id 唯一性规则（R-07）：

```yaml
- id: perse-cua
  config:
    backend: mcp
    command: /Users/you/.local/bin/cua-driver
    serverName: cua
```

然后安装它，并**移除任何指向同一个驱动的裸 `dsh-mcp-client` 行** —— 本插件自己持有那条 MCP 连接：

```sh
npm pack --workspace perse-cua
dsh plugin --profile web add ./perse-cua-0.3.1-rc.1.tgz
```

### 配置项

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `presenterOnly` | `false` | 仅提供预览服务，不监听原生工具结果或启动驱动 |
| `backend` | macOS 为 `native`，其他平台为 `mcp` | 选择 `native` 或 `mcp`；原生执行器要求 macOS 14 及以上 |
| `command` | `cua-driver` | 驱动可执行文件 |
| `args` | `["mcp"]` | 传给驱动的参数 |
| `env` | — | 子进程额外环境变量 |
| `serverName` | `cua` | 命名空间；工具名为 `mcp__<serverName>__<tool>` |
| `allow` | 省略 | 要保留的裸工具名。省略 = 保留驱动声明的全部（减去 `deny`）。传 `MINIMAL_ALLOW` 走仅桌面的紧裁剪（`bestExperience` 下会自动并回光标工具） |
| `deny` | 3 个 shim | 要去掉的裸工具名；优先于 `allow`。`bestExperience: false` 时把 4 个光标工具加回拒绝集 |
| `bestExperience` | `true` | 保留 agent 光标工具，并在启动时显示可见光标（默认使用传输层隐式会话） |
| `bestExperienceSession` | 省略 | 持有最佳体验光标的驱动会话标签 |
| `indicator` | 跟随 `bestExperience` | 显示 macOS 菜单栏指示器；设为 `false` 可关闭 |
| `indicatorStateFile` | `~/Library/Application Support/perse-cua/indicator.json` | 与指示器辅助进程共享的状态文件 |
| `condenseDescriptions` | `true` | 描述压到首句 |
| `trimMenuTrees` | `true` | 从渲染结果里移除 `AXMenu*` 子树 |
| `requestTimeoutMs` | `120000` | 单次调用超时 |
| `startupTimeoutMs` | `30000` | 启动 + 握手预算 |

`allow` 与 `deny` 都同时接受裸名（`click`）和带命名空间的名字（`mcp__cua__click`）。
`allow` 里匹配不到任何实际工具的条目会被记进日志而不是被静默忽略，这样驱动升级改了工具名你能看见。

## 驱动预览

原生预览沿用应用授权，在成功操作后刷新画面；调用或截图失败会清除画面。预览限定于当前选中的 Session，Remote 网关负责该 Session 的访问授权。

MCP 执行器向浏览器客户端推送各窗口的独立画面。窗口读取和针对窗口的操作可识别目标；预览截图沿用操作的会话。选择卡片可放大、切换窗口或关闭卡片。画面时间是收到截图响应的时间。仅当驱动接受的像素点击与同一窗口、会话和截图绑定时，预览会短暂显示点击位置；这是操作标记，真实 agent 光标由驱动绘制在目标窗口上，可能不出现在窗口截图中。没有经验证像素位置的操作不会显示标记。插件在显示预览前检查目标窗口列表；窗口离屏或不存在时保留上次画面和时间，并标记窗口不可见。截图或枚举失败时，卡片标记截图不可用；不再需要时可关闭。预览流意外结束时，客户端清除过期卡片并重试。预览需要 Agent 所有者以及宿主的 Remote 网关和客户端插槽。

原生预览在观察到操作后使用相同的应用授权刷新。调用失败时清除画面并重新截图；仅预览截图失败时标记截图不可用。预览限定于当前会话，Remote 网关负责会话访问授权。

导出的 `PreviewService` 也可由其他提供方调用 `put` 和 `remove`；提供方负责授权、光标行为和移除自己的窗口。

`perse-cua/presenter` 入口仅注册预览服务，不能启动或配置驱动；提供方负责授权和光标行为。动作位置标记指向匹配截图上的提交坐标；驱动可能通过辅助功能而非鼠标按压执行操作。

## 它刻意不做什么

- **不自动重连。** 驱动进程死掉会表现为调用失败，并且在 harness 重载插件前一直失败。
  cua-driver 是本地进程，静默重拉被判定为比明确报错更糟。

## 平台注意

- macOS 的 MCP 执行器需要 Accessibility **和** Screen Recording。跑一次 `cua-driver permissions grant`：
  驱动会通过 LaunchServices 拉起 `CuaDriver.app`，让 TCC 授权挂在 `com.trycua.driver` 上，
  而不是挂在 harness 进程上。
- 动作默认在后台执行，不抢用户焦点。`move_cursor` 在默认的 window 作用域下**只移动 agent 浮层光标**；
  要移动真实系统指针得用 `scope: "desktop"`，那是一次前台接管。
- 菜单栏指示器随插件启动，连续 60 秒没有状态更新后退出。下一次非只读工具调用会重新启动它，
  选择 **Hide indicator** 或启动失败后也会如此；只读调用不会重启指示器。同一插件实例的并发调用
  共享一次待完成的启动。卸载插件会移除状态文件并结束启动等待进程，辅助进程观察到文件移除后退出，
  启动宽限期内最多等待 10 秒。指示器失败不会阻止驱动工具调用。
- 驱动解析不到窗口的无障碍表面时，会返回**空树 + `degraded_reason: ax_window_unresolved`**，
  而不是把错误表面的树交出来。看到这个就重新拉起 app 再快照一次。

## 开发

```sh
npm ci
npm run typecheck
npm run build      # tsc -> lib/types，然后 tsdown -> lib/index.js
npm test           # build + node --test test/*.test.mjs
```

指示器生命周期测试运行构建后的插件，并用真实子进程替代驱动和 LaunchServices 等待进程，
覆盖退出、重试、并发调用与卸载，不启动 GUI。状态栏图标显示、空闲后恢复以及移除效果，
仍需在 macOS 上使用打包的辅助程序单独验证。

打包前会将根目录的中英文 README 和 LICENSE 复制到安装包。
在 macOS 上运行 `npm run build:indicator --workspace perse-cua` 会在临时目录编译双架构 helper；
仅在 ad-hoc 签名与严格验证通过后替换包内 app。交付前需验证归档解压后的签名，
因为同步源目录可能附加 npm 归档不包含的 Finder 元数据。Ad-hoc 签名不代表 Developer ID 签名或公证。

## 许可

MIT —— 见 [LICENSE](LICENSE)。Copyright © 2026 Xilong Liu。
