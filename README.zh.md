# perse-cua

[![ci](https://github.com/persevere-dsh/perse-cua/actions/workflows/ci.yml/badge.svg)](https://github.com/persevere-dsh/perse-cua/actions/workflows/ci.yml)

[English](README.md) | 中文

`perse` = persevere

把 [cua-driver](https://github.com/trycua/cua) 的桌面自动化工具交给 DSH 的模型，
但不再为一次会话根本用不到的部分付费。

**Part of Persevere with DSH**

-----

## 它解决什么

cua-driver 0.28.1 对外声明 **56 个工具**。不管这一轮任务碰不碰图形界面，这 56 个定义都会
挂在**每一次**模型请求上。在发布版驱动上实测：

| | 工具数 | 模型可见 schema | ≈ 每请求 token |
| --- | --- | --- | --- |
| 裸用 `@deepseek-ai/dsh-mcp-client` | 56 | 95.1 KB | ~24,300 |
| 经过 `perse-cua` | 27 | 39.7 KB | ~10,200 |

而当任务真的在操作 app 时，原始窗口快照里绝大部分是菜单栏：在一个 230×408 的计算器窗口上，
菜单子树占 146 个元素中的 145 个、占渲染字节的 **88%**。它永远不可能是操作目标 —— 菜单项要用
`invoke_menu` 按路径走 —— 所以它纯粹是干扰定位的噪音。

## 它做什么

1. **裁剪工具面。** 只保留桌面自动化闭环 —— 发现、观察、动作、校验、剪贴板、诊断 —— 去掉浏览器
   CDP 工具、轨迹录制、光标外观、会话生命周期、自更新探测。可以用配置放宽。
2. **压缩描述**到首句。完整操作手册并没有丢：它本来就以 `cua-driver` 技能的形式随包发布，
   模型需要时按需加载。参数 schema 原样透传，所以每个工具仍然正常校验。
3. **剥掉 AX 菜单栏子树**，窗口块保持逐字节不变 —— 包括原有的元素编号，因为 `element_token`
   必须继续对得上驱动缓存的那份快照。

## 使用

在 profile 的 `cordis.patch.yml` 里加一行 id 定向的 config 覆盖：

```yaml
- id: perse-cua
  config:
    command: /Users/you/.local/bin/cua-driver
    serverName: cua
```

然后安装它，并**移除任何指向同一个驱动的裸 `dsh-mcp-client` 行** —— 本插件自己持有那条 MCP 连接：

```sh
npm pack --workspace perse-cua
dsh plugin --profile web add ./perse-cua-0.1.0.tgz
```

> 插件自带 `dsh.bundle.patch`，安装后已作为 bundle 层注册了同 id 的插入行。
> 因此 profile 里只能写 config 覆盖，**不能再写一条 `insert`**，否则会撞 loader id 唯一性规则（R-07）。

### 配置项

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `command` | `cua-driver` | 驱动可执行文件 |
| `args` | `["mcp"]` | 传给驱动的参数 |
| `env` | — | 子进程额外环境变量 |
| `serverName` | `cua` | 命名空间；工具名为 `mcp__<serverName>__<tool>` |
| `allow` | 见 `DEFAULT_ALLOW` | 要保留的裸工具名 |
| `deny` | `[]` | 要去掉的裸工具名；优先于 `allow` |
| `condenseDescriptions` | `true` | 描述压到首句 |
| `trimMenuTrees` | `true` | 从渲染结果里移除 `AXMenu*` 子树 |
| `requestTimeoutMs` | `120000` | 单次调用超时 |
| `startupTimeoutMs` | `30000` | 启动 + 握手预算 |

`allow` 与 `deny` 都同时接受裸名（`click`）和带命名空间的名字（`mcp__cua__click`）。
`allow` 里匹配不到任何实际工具的条目会被记进日志而不是被静默忽略，这样驱动升级改了工具名你能看见。

## 它刻意不做什么

- **不产出 Typert 工件，因此没有 `codegen` 脚本。** `perse-cua` 不注册 Cordis 服务、不发事件、
  不暴露 `@Remote` 方法，所以 Typert 生成器为它发现不了任何 face，直接以 `discovered: []` 结束。
  manifest 因此不声明 `./typert` / `./remote`，而不是挂一个指向空文件的导出。
  维护者 profile 里那个能正常工作的宿主侧插件 `dsh-zai-search-tools` 是同样的形态。
- **不带浏览器 CDP 工具。** `browser_*` 和旧的 `page` 默认被裁掉；需要时用 `allow` 加回来。
- **不自动重连。** 驱动进程死掉会表现为调用失败，并且在 harness 重载插件前一直失败。
  cua-driver 是本地进程，静默重拉被判定为比明确报错更糟。

## 平台注意

- macOS 需要 Accessibility **和** Screen Recording。跑一次 `cua-driver permissions grant`：
  驱动会通过 LaunchServices 拉起 `CuaDriver.app`，让 TCC 授权挂在 `com.trycua.driver` 上，
  而不是挂在 harness 进程上。
- 动作默认在后台执行，不抢用户焦点。
- 驱动解析不到窗口的无障碍表面时，会返回**空树 + `degraded_reason: ax_window_unresolved`**，
  而不是把错误表面的树交出来。看到这个就重新拉起 app 再快照一次。

## 开发

```sh
npm ci
npm run typecheck
npm run build      # tsc -> lib/types，然后 tsdown -> lib/index.js
npm test           # build + node --test test/*.test.mjs
```

## 许可

MIT —— 见 [LICENSE](LICENSE)。Copyright © 2026 Xilong Liu。
