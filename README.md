# aw-usage-mcp

将 ActivityWatch 数据转化为智能应用使用摘要的 MCP Server —— 智能会话合并、基于 AFK 的活动块切分、跨设备（电脑 + 手机）时间线。

## 快速开始

```bash
# 1. 确保 ActivityWatch 已运行（默认 localhost:5600）
# 2. 安装本包
npm install -g aw-usage-mcp

# 3. 添加到 MCP 客户端配置
```

```json
{
  "mcpServers": {
    "aw-usage": {
      "command": "node",
      "args": ["path/to/aw-usage-mcp/index.js"]
    }
  }
}
```

Agent 可以使用两个工具：

| 工具 | 用途 |
|------|------|
| `get_usage_summary` | 快速摘要 — 每行一个来源，省上下文 |
| `get_usage_sessions` | 完整时间线 — 包含活动块、各应用时长、窗口标题 |

## CLI 使用

```bash
npm run aw:tasker    启动手机接收端口
node scripts/usage-sessions                        默认3小时
node scripts/usage-sessions --phone                只看手机
node scripts/usage-sessions --computer             只看电脑
node scripts/usage-sessions --phone --hours 1      最近1小时手机，可根据需求更改小时数
node scripts/usage-sessions --computer --hours 8   最近8小时电脑，可根据需求更改小时数
node scripts/usage-sessions --merge 10             合并阈值10分钟

node scripts/usage-summary                        默认3小时
node scripts/usage-summary --phone                只看手机
node scripts/usage-summary --computer             只看电脑
node scripts/usage-summary --phone --hours 1      最近1小时手机，可根据需求更改小时数
node scripts/usage-summary --computer --hours 8   最近8小时电脑，可根据需求更改小时数
```

## 功能特性

- **智能活动块切分**：将原始的 AFK 心跳合并成有意义的活跃块，5 分钟无操作自动切分。
- **跨设备时间线**：自动合并电脑和手机数据，统一标注（电脑 / 手机 / 电脑+手机）。
- **双层设计**：`summary` 用于快速状态检查（省 Token），`sessions` 用于详细钻取。

---

## WSL 配置（ActivityWatch 跑在 Windows 上时）

如果你在 Windows 上运行 ActivityWatch，而 MCP Server 跑在 WSL 中，需配置 WSL 使其能访问 Windows 主机的 localhost。启用**镜像网络模式**即可。

### 步骤 1：创建 `.wslconfig` 文件

在 Windows 文件资源管理器地址栏输入 `%UserProfile%`，打开用户主目录，创建文件 `.wslconfig`。

### 步骤 2：添加配置

```ini
[wsl2]
memory=4GB                        # WSL 2 内存大小
processors=2                      # WSL 2 CPU 核心数
localhostForwarding=true          # 启用 localhost 转发

[experimental]
autoMemoryReclaim=gradual         # 自动回收内存
networkingMode=mirrored           # 启用镜像网络
dnsTunneling=true                 # 启用 DNS 隧道
firewall=true                     # 启用 Windows 防火墙集成
autoProxy=true                    # 自动同步代理
sparseVhd=true                    # 自动释放虚拟硬盘空间
```

### 步骤 3：重启 WSL

以管理员身份运行 PowerShell：

```powershell
# 停止 WSL
wsl --shutdown

# 启动 WSL（或直接打开新的 WSL 终端）
wsl
```

### 步骤 4：验证

配置完成后，WSL 内可通过 `localhost` 访问 Windows 主机上的服务：

```bash
curl http://localhost:5600
```

---

## 手机同步

### 方案 A：Tasker 上报（推荐）

通过 Tasker 监听应用切换，实时上报到电脑端 ActivityWatch。

**优点**：实时、无线、一次配置长期有效。

#### 网络配置（二选一）

**局域网方式**：
- 手机和电脑连同一 WiFi
- 电脑 PowerShell 执行 `ipconfig`，记下 IPv4 地址（如 `192.168.1.100`）
- Tasker 中 URL 填 `http://192.168.1.100:5600/`

**Tailscale 方式（推荐，IP 固定）**：
1. 电脑和手机都安装 [Tailscale](https://tailscale.com/download)，登录同一账号
2. 记下电脑的 Tailscale IP（如 `100.123.45.67`）
3. Tasker 中 URL 填 `http://100.123.45.67:5600/`

#### 手机系统设置（必须全部完成）

| 步骤 | 路径 | 操作 |
|------|------|------|
| 1 | 设置 → 隐私保护 → 使用情况访问 | 开启 Tasker |
| 2 | 设置 → 无障碍 → 已安装的服务 → Tasker | 开启 |
| 3 | 手机管家 → 权限 → 自启动 | 开启 Tasker |
| 4 | 设置 → 省电与电池 → Tasker | 设为“无限制” |
| 5 | 手机管家 → 病毒扫描 → Tasker | 选择“忽略” |
| 6 | 多任务界面 → 长按 Tasker 卡片 | 点击锁图标 |
| 7 | **Tasker 首选项 → 监控器 → 监控应用状态途径** | **改为“无障碍”** |

> ⚠️ 第 7 步是**关键**，不设置则 `%WIN` 无法获取应用名。

#### Tasker 配置

**全局变量**（变量 → 右下角 `+`）：

| 变量名 | 用途 |
|--------|------|
| `%AW_CURRENT_APP` | 存储当前前台应用名 |
| `%AW_START_TIME` | 存储开始时间（`%TIMES`） |

**配置文件 1：应用启动**

- 事件 → 界面 → **新窗口**
- 关联任务“记录启动”：
  ```
  变量设置: %AW_CURRENT_APP = %app_name
  变量设置: %AW_START_TIME = %TIMES
  ```

**配置文件 2：新窗口**

- 事件 → 界面 → **新窗口**
- 关联任务“上报时长”：
  ```
  变量设置: %current_win = %WIN
  IF 条件: %current_win 不匹配 %AW_CURRENT_APP 且 %AW_START_TIME 已设置
      变量计算: %duration = %TIMES - %AW_START_TIME
      HTTP 请求:
          方法: POST
          URL: http://电脑IP:5600/
          头部: Content-Type → application/json
          主体: {"app":"%AW_CURRENT_APP","duration":"%duration"}
  ```

**可选：WiFi 自动切换 IP**

如果你在不同网络（公司/住所）需要切换电脑 IP：

- 状态 → 网络 → **WiFi 已连接**
- 关联任务“设置服务器地址”：
  ```
  IF %WIFII 匹配 *公司WiFi*
      变量设置: %SERVER_URL = http://公司IP:5600/
  ELSE IF %WIFII 匹配 *住所WiFi*
      变量设置: %SERVER_URL = http://宿舍IP:5600/
  ELSE
      变量设置: %SERVER_URL = http://TailscaleIP:5600/
  END IF
  ```
- 然后将“上报时长”中的 URL 改为 `%SERVER_URL`

### 方案 B：ActivityWatch Android App（仅本地查看）

安装官方 App 可在手机本地查看使用统计，但数据不会自动同步到电脑。

如需合并电脑数据，建议改用方案 A。

---

## 要求

- [ActivityWatch](https://activitywatch.net/downloads/) 运行中（默认 `localhost:5600`）
- Node.js 14+
- 手机端：Android 7.0+（使用 Tasker 或 ActivityWatch App）

---

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `%duration` 为 0 | `%AW_START_TIME` 未记录 | 确保先触发了“应用启动” |
| HTTP 请求失败 | 网络不通 | 手机浏览器能否打开 `http://电脑IP:5600/`？ |
| `%app_name` 为空 | 未开启使用情况访问 | 系统设置中开启 |
| `%WIN` 为空 | 无障碍未生效 | 检查二、7：监控应用状态途径改为“无障碍” |
| 任务不触发 | 系统杀后台 | 重新检查红米设置全部 7 步 |
| duration 值巨大 | 某次启动后一直未上报 | 正常，IF 条件已处理 |
```

---

## 许可证

MIT

---

## 相关项目

- [ActivityWatch](https://activitywatch.net/) - 开源时间追踪工具
- [Cyberboss](https://github.com/WenXiaoWendy/cyberboss) - 微信桥接的 AI 监督 Agent
- [Tasker](https://tasker.joaoapps.com/) - Android 自动化工具

---

## 更新日志

### v1.0.0 (2026-05-13)

- 初始版本发布
- 支持 `get_usage_summary` 和 `get_usage_sessions` 两个 MCP 工具
- 智能活动块切分（5分钟 AFK 阈值）
- 跨设备时间线合并（电脑 + 手机）
- 提供 Tasker 配置完整指南
- 提供 WSL 镜像网络配置指南

### v0.9.0 (2026-05-10)

- 测试版，内部验证

---

## 致谢

感谢 Cyberboss 作者 WenXiaoWendy 提供的灵感和架构参考。

感谢 ActivityWatch 开源社区提供的数据基础设施。

---

**Happy tracking! 📊**
