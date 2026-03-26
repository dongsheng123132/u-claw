#!/bin/bash
# ============================================================
# M-Claw 一键安装脚本 (Mac/Linux)
# 用法: curl -fsSL https://u-claw.org/install.sh | bash
#       或: bash install.sh
# ============================================================

set -e

# ---- 颜色定义 ----
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ---- 常量 ----
UCLAW_DIR="$HOME/.uclaw"
RUNTIME_DIR="$UCLAW_DIR/runtime"
CORE_DIR="$UCLAW_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
CONFIG_PATH="$DATA_DIR/.openclaw/openclaw.json"
NODE_VERSION="v22.14.0"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"

# ============================================================
# Step 1: Banner + 系统检测
# ============================================================
clear 2>/dev/null || true
echo ""
echo -e "${CYAN}${BOLD}"
cat << 'BANNER'
  ╔══════════════════════════════════════════╗
  ║  🦞 M-Claw 一键安装                      ║
  ║  让 AI 助手一行命令装好                    ║
  ╚══════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# 系统检测
OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ]; then
        PLATFORM="darwin-arm64"
        NODE_DIR="node-mac-arm64"
        echo -e "  系统: ${GREEN}macOS Apple Silicon (M 系列) ✓${NC}"
    else
        PLATFORM="darwin-x64"
        NODE_DIR="node-mac-x64"
        echo -e "  系统: ${GREEN}macOS Intel ✓${NC}"
    fi
elif [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "x86_64" ]; then
        PLATFORM="linux-x64"
        NODE_DIR="node-linux-x64"
        echo -e "  系统: ${GREEN}Linux x64 ✓${NC}"
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        PLATFORM="linux-arm64"
        NODE_DIR="node-linux-arm64"
        echo -e "  系统: ${GREEN}Linux ARM64 ✓${NC}"
    else
        echo -e "  ${RED}不支持的架构: $ARCH${NC}"
        exit 1
    fi
else
    echo -e "  ${RED}不支持的系统: $OS${NC}"
    echo -e "  ${YELLOW}Windows 请使用 PowerShell: irm https://u-claw.org/install.ps1 | iex${NC}"
    exit 1
fi

echo -e "  安装目录: ${CYAN}$UCLAW_DIR${NC}"
echo ""

# 检查已有安装
if [ -d "$UCLAW_DIR/core/node_modules/openclaw" ]; then
    echo -e "  ${YELLOW}检测到已有安装: $UCLAW_DIR${NC}"
    if [ -t 0 ]; then
        read -p "  覆盖安装？(y/n) [y]: " -n 1 OVERWRITE
        echo ""
        if [ "$OVERWRITE" = "n" ] || [ "$OVERWRITE" = "N" ]; then
            echo -e "  ${DIM}已取消${NC}"
            exit 0
        fi
    else
        echo -e "  ${CYAN}管道模式，自动覆盖安装${NC}"
    fi
    echo ""
fi

# 创建目录结构
mkdir -p "$RUNTIME_DIR" "$CORE_DIR" "$DATA_DIR/.openclaw" "$DATA_DIR/memory" "$DATA_DIR/backups"

# ============================================================
# Step 2: Node.js v22 安装
# ============================================================
echo -e "  ${BOLD}[1/7] 安装 Node.js $NODE_VERSION ...${NC}"

NODE_INSTALL_DIR="$RUNTIME_DIR/$NODE_DIR"
INSTALL_NODE=""
INSTALL_NPM=""

# 检查系统 Node.js
USE_SYSTEM_NODE=false
if command -v node >/dev/null 2>&1; then
    SYS_VER=$(node --version)
    MAJOR=$(echo "$SYS_VER" | sed 's/v//' | cut -d. -f1)
    if [ "$MAJOR" -ge 20 ] 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} 系统已有 Node.js $SYS_VER，复用"
        INSTALL_NODE="$(which node)"
        INSTALL_NPM="$(which npm)"
        USE_SYSTEM_NODE=true
    fi
fi

if [ "$USE_SYSTEM_NODE" = "false" ]; then
    if [ -f "$NODE_INSTALL_DIR/bin/node" ]; then
        echo -e "  ${GREEN}✓${NC} Node.js 已存在，跳过下载"
        INSTALL_NODE="$NODE_INSTALL_DIR/bin/node"
        INSTALL_NPM="$NODE_INSTALL_DIR/bin/npm"
    else
        echo -e "  ${CYAN}↓${NC} 从国内镜像下载 Node.js $NODE_VERSION ($PLATFORM)..."
        TARBALL="node-${NODE_VERSION}-${PLATFORM}.tar.gz"
        URL="${NODE_MIRROR}/${NODE_VERSION}/${TARBALL}"

        mkdir -p "$NODE_INSTALL_DIR"
        if command -v curl >/dev/null 2>&1; then
            curl -# -L "$URL" -o "/tmp/$TARBALL"
        elif command -v wget >/dev/null 2>&1; then
            wget -q --show-progress "$URL" -O "/tmp/$TARBALL"
        else
            echo -e "  ${RED}✗ 未找到 curl 或 wget，请先安装${NC}"
            exit 1
        fi

        tar -xzf "/tmp/$TARBALL" -C "$NODE_INSTALL_DIR" --strip-components=1
        rm -f "/tmp/$TARBALL"
        chmod +x "$NODE_INSTALL_DIR/bin/node"

        if [ -f "$NODE_INSTALL_DIR/bin/node" ]; then
            echo -e "  ${GREEN}✓${NC} Node.js 安装完成"
            INSTALL_NODE="$NODE_INSTALL_DIR/bin/node"
            INSTALL_NPM="$NODE_INSTALL_DIR/bin/npm"
        else
            echo -e "  ${RED}✗ Node.js 下载失败${NC}"
            exit 1
        fi
    fi
fi

echo ""

# ============================================================
# Step 3: OpenClaw 安装
# ============================================================
echo -e "  ${BOLD}[2/7] 安装 OpenClaw ...${NC}"

if [ -d "$CORE_DIR/node_modules/openclaw" ]; then
    echo -e "  ${GREEN}✓${NC} OpenClaw 已安装，跳过"
else
    if [ ! -f "$CORE_DIR/package.json" ]; then
        cat > "$CORE_DIR/package.json" << 'PKGJSON'
{
  "name": "u-claw-core",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "openclaw": "latest"
  }
}
PKGJSON
    fi

    echo -e "  ${CYAN}↓${NC} 从国内镜像安装..."
    "$INSTALL_NODE" "$INSTALL_NPM" install --prefix "$CORE_DIR" --registry="$MIRROR" 2>&1 | tail -5
    echo -e "  ${GREEN}✓${NC} OpenClaw 安装完成"
fi

echo ""

# ============================================================
# Step 4: QQ 插件（非致命）
# ============================================================
echo -e "  ${BOLD}[3/7] 安装 QQ 插件 ...${NC}"

if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
    echo -e "  ${GREEN}✓${NC} QQ 插件已安装，跳过"
else
    echo -e "  ${CYAN}↓${NC} 安装 QQ 插件..."
    "$INSTALL_NODE" "$INSTALL_NPM" install @sliverp/qqbot@latest --prefix "$CORE_DIR" --registry="$MIRROR" 2>/dev/null || {
        echo -e "  ${YELLOW}⚠${NC}  QQ 插件安装失败（不影响主功能）"
    }
    if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
        echo -e "  ${GREEN}✓${NC} QQ 插件安装完成"
    fi
fi

echo ""

# ============================================================
# Step 5: 写入 10 个中国技能
# ============================================================
echo -e "  ${BOLD}[4/7] 安装中国本地化技能 (10个) ...${NC}"

SKILLS_TARGET="$CORE_DIR/node_modules/openclaw/skills"
if [ ! -d "$SKILLS_TARGET" ]; then
    mkdir -p "$SKILLS_TARGET"
fi

SKILL_COUNT=0

# ---- bilibili-helper ----
if [ ! -d "$SKILLS_TARGET/bilibili-helper" ]; then
mkdir -p "$SKILLS_TARGET/bilibili-helper"
cat > "$SKILLS_TARGET/bilibili-helper/SKILL.md" << 'SKILLEOF'
---
name: bilibili-helper
description: "B站内容助手 - 视频标题描述优化、标签策略、封面设计建议、分区选择、评论互动"
metadata: { "openclaw": { "emoji": "📺" } }
---

# B站内容助手

帮助 UP 主优化视频标题、描述、标签和封面，提升视频在 B 站的推荐和互动表现。

## 功能概述

- **标题优化**: 符合 B 站用户口味的标题写法
- **描述撰写**: 含时间轴、关键词、引导语的视频简介
- **标签策略**: 精准标签 + 热门标签组合，提升推荐
- **分区建议**: 根据内容推荐最佳投稿分区
- **封面设计**: 封面构图、文字、配色建议
- **评论互动**: 置顶评论话术，提升互动率

## 使用示例

### 写标题和描述
```
我做了一个"用AI写代码"的教程视频，帮我写标题和描述
```

### 分区推荐
```
我的视频内容是游戏+编程结合，应该投哪个分区？
```

### 封面建议
```
视频主题是"大学生省钱攻略"，帮我设计封面方案
```

## 标题公式

1. **疑问式**: "为什么XX？看完你就懂了"
2. **教程式**: "XX教程｜从零开始手把手教学"
3. **测评式**: "花了XX元买了XX，值不值？"
4. **挑战式**: "挑战XX天只用XX"
5. **盘点式**: "XX年度十大XX盘点"
6. **震惊式**: "这也太XX了吧！"（B站经典体）

## 描述模板

```
【视频简介】
一句话概括视频内容

【时间轴】
00:00 开场
01:23 第一部分
05:00 第二部分
08:30 总结

【相关链接】
工具/资源链接

【关于我】
一句话介绍 + 更新频率

三连支持一下吧~ 有问题评论区见！
```

## 分区选择指南

| 内容类型 | 推荐分区 |
|---------|---------|
| 编程教程 | 科技 → 计算机技术 |
| 日常 vlog | 生活 → 日常 |
| 游戏实况 | 游戏 → 单机/网游 |
| 知识科普 | 知识 → 社科人文/科学科普 |
| 美食制作 | 生活 → 美食圈 |
| AI/数码 | 科技 → 软件应用 |

## 标签策略

- **核心标签**: 精确描述视频内容（2-3个）
- **分区热门**: 当前分区下的热门标签（2-3个）
- **全站热门**: B站当前热点话题（1-2个）
- **长尾标签**: 细分领域关键词（2-3个）
- 总计 8-12 个标签效果最佳

## 封面设计要点

- **尺寸**: 16:10（推荐 1146x717）
- **文字**: 不超过 10 字，字体加粗加描边
- **表情**: 人物表情夸张更吸引点击
- **配色**: 高饱和度，与B站粉色/蓝色背景形成对比
- **避免**: 过多文字、低分辨率、与内容无关的封面
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- china-search ----
if [ ! -d "$SKILLS_TARGET/china-search" ]; then
mkdir -p "$SKILLS_TARGET/china-search"
cat > "$SKILLS_TARGET/china-search/SKILL.md" << 'SKILLEOF'
---
name: china-search
description: "国内搜索引擎 - 百度、搜狗、Bing中国搜索，绕过GFW限制"
metadata: { "openclaw": { "emoji": "🔍" } }
---

# 国内搜索引擎助手

在无法访问 Google 的环境下，通过 curl 调用百度、搜狗、Bing 中国等国内搜索引擎获取信息。

## 功能概述

- **百度搜索**: 中文信息最全的搜索引擎
- **搜狗搜索**: 微信公众号文章搜索利器
- **Bing 中国**: 国际信息 + 国内可访问

## 搜索命令

### 百度搜索
```bash
curl -s -L "https://www.baidu.com/s?wd=关键词" \
  -H "User-Agent: Mozilla/5.0" | head -200
```

### 搜狗搜索（含微信文章）
```bash
curl -s -L "https://weixin.sogou.com/weixin?query=关键词" \
  -H "User-Agent: Mozilla/5.0"
```

### Bing 中国搜索
```bash
curl -s -L "https://cn.bing.com/search?q=关键词" \
  -H "User-Agent: Mozilla/5.0"
```

## 搜索技巧

| 语法 | 说明 | 示例 |
|-----|------|------|
| "" | 精确匹配 | "人工智能" |
| site: | 限定网站 | site:zhihu.com AI |
| filetype: | 限定文件类型 | filetype:pdf 机器学习 |
| - | 排除关键词 | 苹果 -手机 |
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- china-translate ----
if [ ! -d "$SKILLS_TARGET/china-translate" ]; then
mkdir -p "$SKILLS_TARGET/china-translate"
cat > "$SKILLS_TARGET/china-translate/SKILL.md" << 'SKILLEOF'
---
name: china-translate
description: "中英互译 + 本地化 - 技术翻译、UI本地化、文化适配、避免机翻腔"
metadata: { "openclaw": { "emoji": "🌐" } }
---

# 中英互译 + 本地化助手

专业的中英双向翻译工具，专注技术文档翻译、产品本地化和文化适配，杜绝机翻腔。

## 功能概述

- **技术翻译**: 编程/AI/互联网领域的专业术语翻译
- **UI 本地化**: 将英文界面文案翻译为符合中文习惯的表达
- **文化适配**: 处理中西文化差异，避免直译造成的误解
- **去机翻腔**: 将僵硬的机器翻译改写为自然流畅的中文

## 常见术语对照表

| English | 中文（推荐） | 避免使用 |
|---------|------------|---------|
| Machine Learning | 机器学习 | 机械学习 |
| Deploy | 部署 | 配置/展开 |
| Repository | 仓库 / 代码仓库 | 存储库 |
| Pull Request | PR / 合并请求 | 拉取请求 |
| Container | 容器 | 集装箱 |
| Middleware | 中间件 | 中间软件 |
| Render | 渲染 | 呈现 |
| Token | Token / 令牌 | 代币（非区块链语境） |
| Prompt | 提示词 / Prompt | 提示语 |
| Fine-tune | 微调 | 精调 |

## UI 本地化指南

- "Submit" → "提交"
- "Cancel" → "取消"
- "Get Started" → "立即开始"
- "Learn More" → "了解更多"
- "Sign Up" → "注册"
- 中文 UI 不需要句号（按钮、标签）
- 中英文之间加半角空格
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- china-weather ----
if [ ! -d "$SKILLS_TARGET/china-weather" ]; then
mkdir -p "$SKILLS_TARGET/china-weather"
cat > "$SKILLS_TARGET/china-weather/SKILL.md" << 'SKILLEOF'
---
name: china-weather
description: "中国城市天气查询 - 支持中文城市名、农历日期、wttr.in接口"
metadata: { "openclaw": { "emoji": "🌤️" } }
---

# 中国城市天气查询

通过 wttr.in 查询中国各城市天气信息，支持中文城市名输入。

## 查询方式

```bash
# 基础查询（中文输出）
curl -s "wttr.in/深圳?lang=zh"

# 精简单行格式
curl -s "wttr.in/深圳?format=3&lang=zh"

# JSON 格式（便于解析）
curl -s "wttr.in/深圳?format=j1"
```

## 使用示例

- 深圳今天天气怎么样？
- 明天要去杭州出差，需要带伞吗？
- 北京和上海这周末天气哪个好？

## 注意事项

- wttr.in 为免费服务，偶尔可能响应较慢
- 温度默认摄氏度，风速默认 km/h
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- deepseek-helper ----
if [ ! -d "$SKILLS_TARGET/deepseek-helper" ]; then
mkdir -p "$SKILLS_TARGET/deepseek-helper"
cat > "$SKILLS_TARGET/deepseek-helper/SKILL.md" << 'SKILLEOF'
---
name: deepseek-helper
description: "DeepSeek API 助手 - 编程辅助、模型选择、API调用指南、定价信息"
metadata: { "openclaw": { "emoji": "🤖" } }
---

# DeepSeek API 助手

帮助用户高效使用 DeepSeek 系列模型，包括模型选择建议、API 调用示例和定价计算。

## 模型对比

| 模型 | 适用场景 | 上下文长度 |
|------|---------|-----------|
| deepseek-chat | 日常对话、文案写作、知识问答 | 32K |
| deepseek-coder | 代码生成、代码审查、技术文档 | 16K |
| deepseek-reasoner | 复杂推理、数学、逻辑分析 | 64K |

## 关键提示

- DeepSeek API 兼容 OpenAI 格式，base_url 改为 `https://api.deepseek.com`
- 国内访问无需翻墙，延迟低
- 支持 function calling 和 JSON mode
- API Key 申请地址: https://platform.deepseek.com
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- douyin-script ----
if [ ! -d "$SKILLS_TARGET/douyin-script" ]; then
mkdir -p "$SKILLS_TARGET/douyin-script"
cat > "$SKILLS_TARGET/douyin-script/SKILL.md" << 'SKILLEOF'
---
name: douyin-script
description: "抖音/快手短视频脚本 - 前3秒hook、脚本结构、热门音乐建议、话题标签策略"
metadata: { "openclaw": { "emoji": "🎬" } }
---

# 抖音/快手短视频脚本助手

帮你写出完播率高、互动强的短视频脚本。

## 脚本结构模板

### 15秒脚本
```
【0-3秒】Hook: 抛出反常识/痛点
【3-10秒】核心内容: 快速讲解
【10-15秒】CTA: 引导互动
```

### 60秒脚本
```
【0-3秒】Hook: 强烈的情绪/悬念
【3-15秒】背景铺垫
【15-40秒】内容展开
【40-50秒】反转/高潮
【50-60秒】CTA + 话题标签
```

## 前3秒 Hook 公式

1. **反常识**: "你一直在做的XX其实是错的"
2. **数字冲击**: "只花了100块，效果比1000块的还好"
3. **悬念提问**: "猜猜这个东西是干什么的？"
4. **情绪共鸣**: "打工人看完都沉默了..."
5. **结果前置**: "最终效果太绝了！往下看做法"

## 话题标签策略

- **大话题**: #抖音热门 #今日份分享（1-2个）
- **中话题**: #健身打卡 #美食教程（2-3个）
- **小话题**: #深圳探店 #程序员日常（2-3个）

## 发布建议

- **黄金时段**: 早7-9点、午12-14点、晚18-22点
- **封面**: 竖屏 9:16，文字大且少（不超过8字）
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- wechat-article ----
if [ ! -d "$SKILLS_TARGET/wechat-article" ]; then
mkdir -p "$SKILLS_TARGET/wechat-article"
cat > "$SKILLS_TARGET/wechat-article/SKILL.md" << 'SKILLEOF'
---
name: wechat-article
description: "微信公众号文章写作 - 文章结构、排版规范、阅读转化优化、封面建议"
metadata: { "openclaw": { "emoji": "💚" } }
---

# 微信公众号文章写作助手

帮助运营者写出高阅读、高转发的微信公众号文章。

## 文章结构模板

```
【标题】控制在 30 字以内，前 15 字抓眼球
【摘要】出现在分享卡片，控制在 54 字

【引言】1-2 段，建立共鸣或抛出问题

【正文】
## 小标题一
内容段落...（每段 3-5 行）

## 小标题二
内容段落...

【总结】回扣主题，升华观点

【尾部】
觉得有收获？点个「在看」让更多人看到
```

## 微信排版规范

- **正文字号**: 15-16px
- **行间距**: 1.75-2倍
- **段间距**: 空一行
- **配色**: 正文 #3f3f3f，强调 #007AFF
- **图片**: 宽度 100%，JPG，单张不超过 5MB

## 标题技巧

1. **数字开头**: "3个方法/5分钟学会"
2. **疑问式**: "为什么XX？答案出乎意料"
3. **对比式**: "XX和XX的差距，在于这一点"
4. **紧迫感**: "再不XX就晚了"
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- weibo-poster ----
if [ ! -d "$SKILLS_TARGET/weibo-poster" ]; then
mkdir -p "$SKILLS_TARGET/weibo-poster"
cat > "$SKILLS_TARGET/weibo-poster/SKILL.md" << 'SKILLEOF'
---
name: weibo-poster
description: "微博内容创作 - 140字优化、话题热搜、@提及策略、配图描述、发布时机"
metadata: { "openclaw": { "emoji": "🔴" } }
---

# 微博内容创作助手

帮你写出高转发、高互动的微博内容。

## 微博内容模板

### 短微博（140字以内）
```
【观点/金句】一句话表达核心观点
【补充说明】1-2句展开
【话题标签】#话题一# #话题二#
```

## 140字写作技巧

- **先写后删**: 先完整表达，再精简到 140 字
- **一条一观点**: 不要在一条微博里讲太多
- **金句收尾**: 最后一句要值得被转发

## 配图建议

- **1张图**: 重点突出，适合海报/截图
- **3张图**: 对比/过程展示
- **6张图**: 故事叙述
- **9张图**: 九宫格，视觉冲击力最强

## 发布时间建议

- **工作日**: 午休 12:00-13:00、下班后 18:00-20:00
- **周末**: 上午 10:00-11:00、晚上 20:00-22:00
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- xiaohongshu-writer ----
if [ ! -d "$SKILLS_TARGET/xiaohongshu-writer" ]; then
mkdir -p "$SKILLS_TARGET/xiaohongshu-writer"
cat > "$SKILLS_TARGET/xiaohongshu-writer/SKILL.md" << 'SKILLEOF'
---
name: xiaohongshu-writer
description: "小红书笔记写作助手 - 标题优化、emoji策略、话题标签、封面文案、笔记结构"
metadata: { "openclaw": { "emoji": "📕" } }
---

# 小红书笔记写作助手

专业的小红书内容创作工具，帮你写出高互动、高收藏的爆款笔记。

## 笔记结构模板

```
【标题】数字 + 痛点/好奇心 + emoji
例: 打工人必看！5个让老板刮目相看的汇报技巧 💼

【开头 Hook】1-2句直击痛点
【正文】分点罗列，每点 2-3 行
1️⃣ 第一点...
2️⃣ 第二点...

【结尾 CTA】
觉得有用就 ❤️ 收藏起来慢慢看！

【话题标签】
#职场干货 #汇报技巧 #打工人必看
```

## 标题公式

1. **数字法**: "5个/10种/100元以内" + 关键词
2. **反差法**: "月薪3千 vs 月薪3万的区别"
3. **身份法**: "作为XX人/XX年经验告诉你"
4. **测评法**: "亲测有效！" + 结果
5. **合集法**: "XX合集｜一篇搞定"

## 写作要点

- 每段不超过 3 行
- emoji 不要堆砌，每段 1-2 个
- 话题标签 3-8 个为佳
- 封面文案控制在 10 字以内
- 发布时间: 早7-9点、午12-14点、晚20-22点
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

# ---- zhihu-writer ----
if [ ! -d "$SKILLS_TARGET/zhihu-writer" ]; then
mkdir -p "$SKILLS_TARGET/zhihu-writer"
cat > "$SKILLS_TARGET/zhihu-writer/SKILL.md" << 'SKILLEOF'
---
name: zhihu-writer
description: "知乎回答/文章写作 - 回答结构、专业语气、引用规范、话题关联、盐值优化"
metadata: { "openclaw": { "emoji": "📝" } }
---

# 知乎回答/文章写作助手

帮助创作者写出高赞、高收藏的知乎内容。

## 回答结构模板

```
【开头】直接回答问题 + 亮明立场
"作为一个做了5年XX的人，我的回答是：..."

---

【正文】分点论述，有理有据
一、第一个论点 + 数据/案例
二、第二个论点 + 个人经验
三、第三个论点 + 行业分析

【总结】回扣问题，给出实操建议
```

## 知乎写作风格

- **自信但不傲慢**: "以我的经验来看"
- **专业但易懂**: 术语需要解释
- **有态度但包容**: 尊重不同立场
- **真诚分享**: 多用个人经验和案例

## 盐值优化

- 回答字数建议 500-3000 字
- 避免复制粘贴，用自己的语言
- 回复评论，参与讨论
- 持续在 2-3 个话题下创作
SKILLEOF
SKILL_COUNT=$((SKILL_COUNT + 1))
fi

echo -e "  ${GREEN}✓${NC} 中国技能安装完成 (+${SKILL_COUNT} 个)"
echo ""

# ============================================================
# Step 6: 交互式模型配置
# ============================================================
echo -e "  ${BOLD}[5/7] 配置 AI 模型 ...${NC}"
echo ""

# 如果已有配置且包含 apiKey，跳过
if [ -f "$CONFIG_PATH" ] && grep -q '"apiKey"' "$CONFIG_PATH" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} 已有模型配置，跳过"
else
    # 检测是否可交互
    if [ -t 0 ]; then
        echo -e "  请选择 AI 模型:"
        echo ""
        echo -e "  ${BOLD}── 国内推荐（无需翻墙）──${NC}"
        echo -e "  ${GREEN}1)${NC} DeepSeek      ⭐ 推荐，性价比最高"
        echo -e "  ${NC}2)${NC} Kimi/月之暗面"
        echo -e "  ${NC}3)${NC} 通义千问/阿里"
        echo -e "  ${NC}4)${NC} 智谱GLM"
        echo -e "  ${NC}5)${NC} MiniMax"
        echo -e "  ${NC}6)${NC} 豆包/火山引擎"
        echo -e "  ${NC}7)${NC} 硅基流动"
        echo ""
        echo -e "  ${BOLD}── 海外模型 ──${NC}"
        echo -e "  ${NC}8)${NC} Claude    ${NC}9)${NC} GPT"
        echo ""
        echo -e "  ${BOLD}── 本地 ──${NC}"
        echo -e "  ${NC}10)${NC} Ollama 本地模型"
        echo ""
        read -p "  请输入编号 [1]: " MODEL_CHOICE
        MODEL_CHOICE=${MODEL_CHOICE:-1}

        # 模型配置映射
        case $MODEL_CHOICE in
            1)
                MODEL_NAME="deepseek-chat"
                BASE_URL="https://api.deepseek.com/v1"
                PROVIDER="custom"
                KEY_LABEL="DeepSeek API Key"
                KEY_HINT="获取地址: https://platform.deepseek.com/api_keys"
                NEED_KEY=true
                ;;
            2)
                MODEL_NAME="moonshot-v1-auto"
                BASE_URL="https://api.moonshot.cn/v1"
                PROVIDER="custom"
                KEY_LABEL="Moonshot API Key"
                KEY_HINT="获取地址: https://platform.moonshot.cn/console/api-keys"
                NEED_KEY=true
                ;;
            3)
                MODEL_NAME="qwen-plus"
                BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
                PROVIDER="custom"
                KEY_LABEL="通义千问 API Key"
                KEY_HINT="获取地址: https://dashscope.console.aliyun.com/apiKey（有免费额度）"
                NEED_KEY=true
                ;;
            4)
                MODEL_NAME="glm-4-plus"
                BASE_URL="https://open.bigmodel.cn/api/paas/v4"
                PROVIDER="custom"
                KEY_LABEL="智谱 API Key"
                KEY_HINT="获取地址: https://open.bigmodel.cn/usercenter/apikeys"
                NEED_KEY=true
                ;;
            5)
                MODEL_NAME="abab6.5s-chat"
                BASE_URL="https://api.minimax.chat/v1"
                PROVIDER="custom"
                KEY_LABEL="MiniMax API Key"
                KEY_HINT="获取地址: https://platform.minimaxi.com/"
                NEED_KEY=true
                ;;
            6)
                MODEL_NAME="doubao-pro-256k"
                BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
                PROVIDER="custom"
                KEY_LABEL="火山引擎 API Key"
                KEY_HINT="获取地址: https://console.volcengine.com/ark"
                NEED_KEY=true
                ;;
            7)
                MODEL_NAME="deepseek-ai/DeepSeek-V3"
                BASE_URL="https://api.siliconflow.cn/v1"
                PROVIDER="custom"
                KEY_LABEL="硅基流动 API Key"
                KEY_HINT="获取地址: https://cloud.siliconflow.cn/account/ak"
                NEED_KEY=true
                ;;
            8)
                MODEL_NAME="claude-sonnet-4-20250514"
                BASE_URL=""
                PROVIDER="anthropic"
                KEY_LABEL="Anthropic API Key"
                KEY_HINT="获取地址: https://console.anthropic.com/settings/keys（需翻墙）"
                NEED_KEY=true
                ;;
            9)
                MODEL_NAME="gpt-4o"
                BASE_URL=""
                PROVIDER="openai"
                KEY_LABEL="OpenAI API Key"
                KEY_HINT="获取地址: https://platform.openai.com/api-keys（需翻墙）"
                NEED_KEY=true
                ;;
            10)
                MODEL_NAME="llama3.2"
                BASE_URL="http://127.0.0.1:11434/v1"
                PROVIDER="custom"
                KEY_LABEL=""
                KEY_HINT="先安装 Ollama (https://ollama.com)，然后运行: ollama run llama3.2"
                NEED_KEY=false
                ;;
            *)
                echo -e "  ${YELLOW}未知选项，使用默认 DeepSeek${NC}"
                MODEL_NAME="deepseek-chat"
                BASE_URL="https://api.deepseek.com/v1"
                PROVIDER="custom"
                KEY_LABEL="DeepSeek API Key"
                KEY_HINT="获取地址: https://platform.deepseek.com/api_keys"
                NEED_KEY=true
                ;;
        esac

        echo ""

        # 输入 API Key
        API_KEY=""
        if [ "$NEED_KEY" = "true" ]; then
            echo -e "  ${CYAN}$KEY_HINT${NC}"
            echo ""
            read -p "  请输入 $KEY_LABEL: " API_KEY
            if [ -z "$API_KEY" ]; then
                echo -e "  ${YELLOW}⚠ 未输入 API Key，稍后可通过 Config.html 配置${NC}"
            fi
        else
            echo -e "  ${CYAN}$KEY_HINT${NC}"
        fi

        # 写配置文件
        if [ "$PROVIDER" = "custom" ] && [ -n "$BASE_URL" ]; then
            cat > "$CONFIG_PATH" << CFGEOF
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "agent": {
    "model": "$MODEL_NAME",
    "apiKey": "$API_KEY",
    "baseUrl": "$BASE_URL"
  }
}
CFGEOF
        elif [ "$PROVIDER" = "anthropic" ]; then
            cat > "$CONFIG_PATH" << CFGEOF
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "agent": {
    "model": "$MODEL_NAME",
    "apiKey": "$API_KEY",
    "provider": "anthropic"
  }
}
CFGEOF
        elif [ "$PROVIDER" = "openai" ]; then
            cat > "$CONFIG_PATH" << CFGEOF
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "agent": {
    "model": "$MODEL_NAME",
    "apiKey": "$API_KEY",
    "provider": "openai"
  }
}
CFGEOF
        fi

        echo -e "  ${GREEN}✓${NC} 模型配置完成: $MODEL_NAME"
    else
        # 非交互模式，写默认配置
        echo -e "  ${YELLOW}⚠${NC}  管道模式，跳过模型选择"
        echo -e "  ${DIM}启动后用 Config.html 配置模型${NC}"
        if [ ! -f "$CONFIG_PATH" ]; then
            cat > "$CONFIG_PATH" << 'CFGEOF'
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  }
}
CFGEOF
        fi
    fi
fi

echo ""

# ============================================================
# Step 7: 生成启动脚本 + 验证 + 摘要
# ============================================================
echo -e "  ${BOLD}[6/7] 生成启动脚本 ...${NC}"

# Mac 启动脚本
cat > "$UCLAW_DIR/start.command" << 'STARTEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH=$(uname -m)

# Find Node.js
if [ "$ARCH" = "arm64" ]; then
    NODE_BIN="$DIR/runtime/node-mac-arm64/bin/node"
else
    NODE_BIN="$DIR/runtime/node-mac-x64/bin/node"
fi
[ ! -f "$NODE_BIN" ] && NODE_BIN="$(which node 2>/dev/null)"

if [ -z "$NODE_BIN" ] || [ ! -f "$NODE_BIN" ]; then
    echo "错误: 未找到 Node.js"
    exit 1
fi

OPENCLAW_MJS="$DIR/core/node_modules/openclaw/openclaw.mjs"
if [ ! -f "$OPENCLAW_MJS" ]; then
    echo "错误: 未找到 OpenClaw"
    exit 1
fi

export OPENCLAW_HOME="$DIR/data"
export OPENCLAW_STATE_DIR="$DIR/data/.openclaw"
export OPENCLAW_CONFIG_PATH="$DIR/data/.openclaw/openclaw.json"

# Find available port
PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    PORT=$((PORT + 1))
    [ $PORT -gt 18799 ] && echo "没有可用端口 (18789-18799)" && exit 1
done

cd "$DIR/core"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
PID=$!

# Wait for gateway to start, then open browser
for i in $(seq 1 30); do
    sleep 0.5
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        open "http://127.0.0.1:$PORT/#token=uclaw" 2>/dev/null || true
        break
    fi
done

echo ""
echo "  🦞 M-Claw 正在运行: http://127.0.0.1:$PORT/#token=uclaw"
echo "  按 Ctrl+C 停止"
echo ""

wait $PID
STARTEOF
chmod +x "$UCLAW_DIR/start.command"

# Linux 启动脚本
if [ "$OS" = "Linux" ]; then
cat > "$UCLAW_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
    NODE_BIN="$DIR/runtime/node-linux-x64/bin/node"
elif [ "$ARCH" = "aarch64" ]; then
    NODE_BIN="$DIR/runtime/node-linux-arm64/bin/node"
fi
[ ! -f "$NODE_BIN" ] && NODE_BIN="$(which node 2>/dev/null)"

OPENCLAW_MJS="$DIR/core/node_modules/openclaw/openclaw.mjs"

export OPENCLAW_HOME="$DIR/data"
export OPENCLAW_STATE_DIR="$DIR/data/.openclaw"
export OPENCLAW_CONFIG_PATH="$DIR/data/.openclaw/openclaw.json"

PORT=18789
while ss -tln | grep -q ":$PORT "; do
    PORT=$((PORT + 1))
    [ $PORT -gt 18799 ] && echo "没有可用端口" && exit 1
done

cd "$DIR/core"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
PID=$!

sleep 2
echo ""
echo "  🦞 M-Claw 正在运行: http://127.0.0.1:$PORT/#token=uclaw"
echo "  按 Ctrl+C 停止"
echo ""

xdg-open "http://127.0.0.1:$PORT/#token=uclaw" 2>/dev/null || true
wait $PID
STARTEOF
chmod +x "$UCLAW_DIR/start.sh"
fi

echo -e "  ${GREEN}✓${NC} 启动脚本已生成"
echo ""

# ============================================================
# 验证
# ============================================================
echo -e "  ${BOLD}[7/7] 验证安装 ...${NC}"
echo ""

# Node.js
if [ -n "$INSTALL_NODE" ] && "$INSTALL_NODE" --version >/dev/null 2>&1; then
    NODE_VER_STR=$("$INSTALL_NODE" --version)
    echo -e "  ${GREEN}[✓]${NC} Node.js $NODE_VER_STR"
else
    echo -e "  ${RED}[✗]${NC} Node.js"
fi

# OpenClaw
if [ -f "$CORE_DIR/node_modules/openclaw/openclaw.mjs" ]; then
    echo -e "  ${GREEN}[✓]${NC} OpenClaw 已安装"
else
    echo -e "  ${RED}[✗]${NC} OpenClaw"
fi

# QQ 插件
if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
    echo -e "  ${GREEN}[✓]${NC} QQ 插件"
else
    echo -e "  ${YELLOW}[⚠]${NC} QQ 插件（未安装，不影响主功能）"
fi

# 技能
INSTALLED_SKILLS=$(ls -d "$SKILLS_TARGET"/*/ 2>/dev/null | wc -l | tr -d ' ')
echo -e "  ${GREEN}[✓]${NC} 中国技能 (${INSTALLED_SKILLS}个)"

# 配置文件
if [ -f "$CONFIG_PATH" ]; then
    echo -e "  ${GREEN}[✓]${NC} 配置文件"
else
    echo -e "  ${YELLOW}[⚠]${NC} 配置文件（需启动后配置）"
fi

echo ""

# ============================================================
# 摘要
# ============================================================
INSTALL_SIZE=$(du -sh "$UCLAW_DIR" 2>/dev/null | cut -f1)

echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   ✅ M-Claw 安装成功！                    ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${BOLD}安装位置:${NC} $UCLAW_DIR"
echo -e "  ${BOLD}大小:${NC}     $INSTALL_SIZE"
echo ""
echo -e "  ${BOLD}启动方式:${NC}"
if [ "$OS" = "Darwin" ]; then
    echo -e "    双击 ${CYAN}~/.uclaw/start.command${NC}"
    echo -e "    或终端: ${CYAN}bash ~/.uclaw/start.command${NC}"
else
    echo -e "    终端: ${CYAN}bash ~/.uclaw/start.sh${NC}"
fi
echo ""
echo -e "  ${BOLD}打开后:${NC}"
echo -e "    浏览器自动打开 → 开始和 AI 对话"
echo ""
echo -e "  ${DIM}如需重新配置模型，编辑 ~/.uclaw/data/.openclaw/openclaw.json${NC}"
echo -e "  ${DIM}卸载: rm -rf ~/.uclaw${NC}"
echo ""
