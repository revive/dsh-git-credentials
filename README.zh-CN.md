# dsh-git-credentials

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4b32c3)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) · 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立外挂插件：管理 GitLab、GitHub、Gitee、Gitea 与 Bitbucket 的 API token，**token 值永不进入大模型的上下文**。

模型工具只携带 token 的**引用名**（如 `GITLAB_TOKEN`），每次调用时才从插件自己的加密存储中解密一次，token 只出现在发出的 HTTP 请求头里。修改站点或轮换 token 后下一次调用立即生效，无需重启。

## 特性

- **token 不进入模型上下文**——工具参数、返回值、错误信息里只有业务数据（`site`、`project`、`path` 等）
- **磁盘静态加密**——AES-256-GCM 整体加密的数据文件 + 独立的 32 字节随机密钥文件（`0600`、原子写入）
- **按 provider 限定工具**——`gitlab_*` 只见 GitLab 站点，`github_*` 只见 GitHub 站点，`gitee_*` / `gitea_*` / `bitbucket_*` 同理；未配置的 site/token 响亮失败并列出合法值
- **Web 设置面板**——添加/编辑/删除站点、写入或清除 token 值；**任何响应都不携带 token 值**，只报配置状态
- **动态加载/卸载**——运行中的 GUI 直接热挂载/热卸载，无需重启
- **即时生效**——每次工具调用读一份解密快照，改动和轮换立即生效

## 为什么不用 MCP server？

GitHub 发布了官方 MCP server，harness 也原生支持 MCP 客户端——如果只需要 GitHub，接入官方 MCP server 是更主流的选择，本插件的 `github_*` 工具确实与它功能重叠。

本插件的价值在 MCP 覆盖不到的地方：

| | 官方 GitHub MCP | 本插件 |
|---|---|---|
| 覆盖平台 | 只有 GitHub（GitLab 有官方 server；Gitee / Gitea / Bitbucket 依赖第三方 server，质量与维护参差） | 一个加密存储、一个设置面板、一套工具管 GitLab、GitHub、Gitee、Gitea、Bitbucket——含自托管 Gitea / GitLab |
| token 处理 | 每台 server 环境变量明文配置，无管理界面 | AES-256-GCM 加密存储 + token 引用名 + 设置页管理；token 值永不进入模型上下文 |
| 集成形态 | 多一层 MCP 代理进程 | 工具直接注册进 harness 工具注册表 |

单一托管平台 + 标准 token 处理，走 MCP 即可；多 forge（尤其是 Gitee、自托管 Gitea）、或想要加密存储 + 产品内管理页面时，用本插件。

## 安全模型

### 存储

- `~/.dsh/git-credentials.json` — 数据文件，AES-256-GCM 整体加密（`0600`、原子写入）
- `~/.dsh/git-credentials.key` — 32 字节随机密钥，独立文件存放（`0600`）

### 威胁模型

| 场景 | 是否防护 |
|---|---|
| 有人拷走/备份/同步**数据文件** | ✅ 是——只有密文，没有密钥文件解不开 |
| **同 UID 进程**（如 agent 的 bash/fs 工具）读取两个文件 | ❌ 否——密钥与数据同权限，与产品自身密钥处理同级（"discretion, not a boundary"） |
| **用户主动**让模型去读文件 | ❌ 否——不在防护范围内，任何系统都拦不住 |

密钥文件丢失 = 数据不可解（解密失败会响亮报错并提示密钥路径）；数据文件单独被拷走 = 安全。

## 安装

插件是纯外挂，产品代码零改动，`~/.dsh` 下只需两处：

1. 符号链接插件目录，让所有 profile 都能解析包名：

   ```sh
   mkdir -p ~/.dsh/profiles/node_modules
   ln -s /path/to/dsh-git-credentials ~/.dsh/profiles/node_modules/dsh-git-credentials
   ```

2. 在 home 层覆盖文件 `~/.dsh/cordis.patch.yml` 中追加插件行（对 web/headless 等所有 profile 生效）：

   ```yaml
   - insert:
       - id: git-credentials
         name: 'dsh-git-credentials'
   ```

HMR watcher 监控 home 层：加行 = 热挂载（运行中的 GUI 直接生效），删行 / `disabled: true` = 热卸载，改配置 = 热重配。卸载即删掉这两处。

> 浏览器半（`lib/client.js`）是构建产物——克隆后先构建（见[开发](#开发)）。

## 用法

在 **设置 → Git 凭据** 中管理站点与 token：

- **添加站点**：provider（GitLab / GitHub / Gitee / Gitea / Bitbucket）、站点 id、API 地址（各 provider 默认值：`https://api.github.com`、`https://gitee.com/api/v5`、`https://api.bitbucket.org/2.0`；GitLab 与 Gitea 是自托管，需自己填地址，如 `https://gitlab.example.com` / `https://gitea.example.com/api/v1`）、token 引用名（默认 `GITLAB_TOKEN` / `GITHUB_TOKEN` / `GITEE_TOKEN` / `GITEA_TOKEN` / `BITBUCKET_TOKEN`）、token 值（可选，可用专属的「保存 Token」按钮单独写入，也可随「添加站点」一并写入）、默认项目（可选）
- **每个已保存的站点**：默认只读展示（provider、地址、tokenRef、默认项目、token 配置状态），点「编辑」才显示文本框与「保存 / 取消」；编辑态可改配置、单独保存或清除 token 值、删除站点
- 面板通过同源 `/git-credentials-admin/*` JSON 端点读写加密存储；任何响应都不携带 token 值
- 所有改动即时生效——每次工具调用读一份解密快照

### 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `gitlab_projects` | `site?`、`search?`、`membership?`、`perPage?` | 项目摘要数组 |
| `gitlab_file` | `site?`、`project`、`path`、`ref?` | `{ path, ref, content, truncated }` |
| `gitlab_merge_requests` | `site?`、`project?`、`state?`、`perPage?` | MR 摘要数组 |
| `gitlab_issues` | `site?`、`project?`、`state?`、`perPage?` | issue 摘要数组 |
| `github_repos` | `site?`、`search?`、`perPage?` | 仓库摘要数组 |
| `github_file` | `site?`、`project`（owner/repo）、`path`、`ref?` | `{ path, ref, content, truncated }` |
| `github_issues` | `site?`、`project?`、`state?`、`perPage?` | issue 摘要数组（不含 PR） |
| `github_pull_requests` | `site?`、`project?`、`state?`、`perPage?` | PR 摘要数组 |
| `gitee_repos` | `site?`、`search?`、`perPage?` | 仓库摘要数组 |
| `gitee_file` | `site?`、`project`（owner/repo）、`path`、`ref?` | `{ path, ref, content, truncated }` |
| `gitee_issues` | `site?`、`project?`、`state?`、`perPage?` | issue 摘要数组 |
| `gitee_pull_requests` | `site?`、`project?`、`state?`、`perPage?` | PR 摘要数组 |
| `gitea_repos` | `site?`、`search?`、`perPage?` | 仓库摘要数组 |
| `gitea_file` | `site?`、`project`（owner/repo）、`path`、`ref?` | `{ path, ref, content, truncated }` |
| `gitea_issues` | `site?`、`project?`、`state?`、`perPage?` | issue 摘要数组 |
| `gitea_pull_requests` | `site?`、`project?`、`state?`、`perPage?` | PR 摘要数组 |
| `bitbucket_repos` | `site?`、`search?`、`perPage?` | 仓库摘要数组 |
| `bitbucket_file` | `site?`、`project`（workspace/repo）、`path`、`ref?` | `{ path, ref, content, truncated }` |
| `bitbucket_issues` | `site?`、`project?`、`state?`、`perPage?` | issue 摘要数组 |
| `bitbucket_pull_requests` | `site?`、`project?`、`state?`、`perPage?` | PR 摘要数组 |

- token 引用名是 POSIX 标识符（`GITLAB_TOKEN`、`GITHUB_TOKEN`、`GITEE_TOKEN`、`GITEA_TOKEN`、`BITBUCKET_TOKEN`…），多站点可各配各的 ref，或共享一个 ref
- GitLab 用 `PRIVATE-TOKEN` 头；GitHub、Gitee、Bitbucket 用 `Authorization: Bearer`（Gitee 在头被拒绝时自动兜底 `access_token` URL 参数）；Gitea 用 `Authorization: token`
- HTTP 走 Node 内置 `fetch` 直连——刻意不用 `ctx.web.fetch`（只收 URL、无 header）

## 工作原理

```
~/.dsh/git-credentials.json（AES-256-GCM 加密：站点 + token 值）
  → 工具执行时解密一份快照，按 provider 过滤站点 + resolve(tokenRef)
  → fetch(baseUrl/<provider api path>, { headers: { PRIVATE-TOKEN | Bearer | token } })
  → 工具参数/返回值/错误信息里只有 site、project、path 等业务数据
```

## 开发

前置条件：一份 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 检出。开发工具链由 harness 提供：把 `DSH_REPO` 指向检出目录，并将其 `node_modules/.bin` 加入 `PATH`（`@deepseek-ai/*` 为私有包，通过 harness 的 tsconfig paths 解析）。

```sh
export DSH_REPO=/path/to/deepseek-harness
export PATH="$DSH_REPO/node_modules/.bin:$PATH"

# 为当前检出重新生成 tsconfig.json paths（已被 gitignore——机器相关）
pnpm gen:tsconfig

# 类型检查（含 browser half）
pnpm typecheck

# keyless 冒烟：加密存储回读 + boot 断言 + 未配置 token 响亮失败（无网络、无模型 key）
DSH_REPO="$DSH_REPO" TSX_TSCONFIG_PATH="$DSH_REPO/tsconfig.json" \
  node --import "$DSH_REPO/node_modules/tsx/dist/esm/index.mjs" smoke.ts

# 改过 src/client/ 后重建浏览器 bundle（运行中的 GUI 自动热替换）
pnpm build
```

- **组合/配置层**：HMR 自动重组合，改完立即生效
- **client bundle**：webserver 轮询 + client-hmr 广播，重建后浏览器自动热替换
- **host 插件源码**：没有热更通道（Node 持有模块缓存，产品自身也没有 host 侧 watch）；且包入口已是构建产物 `lib/index.js`，host 侧改动需先 `pnpm build` 再重启——或用「目录改名」技巧让模块 URL 全变，零重启热生效

`$DSH_REPO/node_modules/.bin/tsdown` 是 shell 包装脚本——直接执行（`pnpm build` 即如此），不要用 `node .../.bin/tsdown`。

## 目录结构

```
git-credentials/
  package.json            # dsh-git-credentials；peer: @deepseek-ai/{cordis,dsh-tools,dsh-schemastery}
                          # dsh.client 清单 + exports["./client"]（browser half）
  cordis.patch.yml        # bundle 补丁层（dsh.bundle.patch）——同时也是开发用 --patch 覆盖层
  tsdown.config.ts        # 复用仓库 clientBundle 预设构建 lib/
  smoke.ts                # keyless 启动冒烟（含加密存储回读断言）
  tools/gen-tsconfig.mjs  # 重新生成 tsconfig.json paths（DSH_REPO 驱动）
  src/index.ts            # 插件入口：8 个工具注册 + 管理路由接线
  src/store.ts            # AES-256-GCM 加密存储（独立密钥、原子写、0600）
  src/http.ts             # 共享 HTTP 助手（token 解析、分页、错误明细）
  src/gitlab.ts           # GitLabClient（PRIVATE-TOKEN 头）
  src/github.ts           # GitHubClient（Bearer 头 + User-Agent）
  src/gitee.ts            # GiteeClient（Bearer 头，access_token URL 兜底）
  src/gitea.ts            # GiteaClient（token 头）
  src/bitbucket.ts        # BitbucketClient（Bearer 头，2.0 API）
  src/admin.ts            # /git-credentials-admin/* 管理端点
  src/invariant.ts        # 不变量伴生（out-of-tree 原因）
  src/client/             # browser half：设置页 Git 凭据分区
  lib/                    # 构建产物（node 半 + client bundle，已 gitignore）
```

## 发布

包已按 dsh **bundle** 形态组织：`dsh.bundle.patch` 指向 `cordis.patch.yml`，用户执行 `dsh plugin --profile <name> add dsh-git-credentials` 即可安装并加入 profile 的 bundle 层。运行时通过安装自身的 flat fallback（`$DSH_HOME/profiles/node_modules`）解析插件的 `@deepseek-ai/*` 依赖，因此 peerDependencies 声明的是 **npm 已发布版本线**（`@deepseek-ai/cordis ^4.0.1-rc.1`、`@deepseek-ai/dsh-tools ^0.0.1-rc.1`、`@deepseek-ai/schemastery ^3.18.1-rc.1`）——切勿用开发工作区的 `0.1.0-rc.5` 版本。

```sh
# 先构建 node 半 + 浏览器 bundle，再发布（需要 npm 账号）
DSH_REPO=/path/to/deepseek-harness pnpm build
npm publish

# 或者不打 registry，用 tarball 分发：
pnpm pack
dsh plugin --profile <name> add ./dsh-git-credentials-<version>.tgz
```

发布前先在本地验证 tarball：`dsh plugin --profile <name> add <tarball>`，确认 `dsh --profile <name> --dump-config` 出现 `# == dsh-git-credentials` 层，再 boot profile 检查 8 个工具是否注册。

## License

[MIT](LICENSE)
