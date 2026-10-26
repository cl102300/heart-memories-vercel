# Heart Memories - 三维浪漫记忆相册

带账户登录的照片收藏系统，提供精致照片墙与可选的三维展览；同一账户可在多台设备共享照片。

## ✨ 核心特性

### 📸 私人照片收藏
- 首次打开显示空相册引导，不依赖远程示例图片。
- 支持批量添加 JPG、PNG、WebP 图片，也可以拖拽导入。
- 展示用缩略图会统一裁切为 4:5 胶片画幅并加轻微暖调；大图查看显示原图。
- 原图保存在私有 Vercel Blob；账户、缩略图和照片信息保存在 Neon Postgres。
- 点击照片可放大查看，并用左右方向键切换；可删除单张照片或清空相册。
- 登录同一账户的手机可以上传、查看和删除同一本相册中的照片。
- 可在「信息设置」中修改相册显示的两位姓名；设置会随账号同步。
- 注册时绑定手机号后，可在登录页通过手机号匹配找回密码，也可在设置中修改密码。
- 旧版本保存在本机浏览器的照片，可登录后通过「导入旧照片」上传到账户。
- 最多保存 999 张；单张照片上限为 25 MB。

### 🌌 可选三维展览
- 照片沿螺旋轨道分布，支持旋转、缩放、布局切换和大图查看。
- 自动按数量切换布局：0–20 张圆环（空相册不显示三维场景）、21–99 张爱心、100–499 张球体、500–999 张多层星系。
- 照片较多时精简三维相框装饰，减少渲染负担。

### 🎵 音乐联动
- 播放/暂停控制
- 音量调节
- 时间显示
- 场景切换时保持音乐状态

## 🚀 快速开始

运行环境需要 Node.js 22.13 或更高版本。

```bash
# 安装依赖
npm install

# 配置 Neon Postgres 和 Vercel Blob 凭据
Copy-Item .env.example .env

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 启动已构建的生产服务
npm start
```

在 `.env` 中设置 `DATABASE_URL` 和 `BLOB_READ_WRITE_TOKEN` 后，开发服务器默认运行在 `http://localhost:3000/`。首次使用时创建账户并绑定手机号；另一台手机登录相同账户即可访问同一相册。开发时，手机也可以访问电脑显示的局域网地址。

Postgres 表会在首次 API 请求时自动创建。照片原图通过浏览器直传私有 Blob，不经过 Vercel Function，因此保留 25 MB 单张上限。

## Vercel 部署

1. 在 Vercel 项目中连接 Neon Postgres，并创建一个 **Private** Vercel Blob Store。
2. 确认部署环境中配置了 `DATABASE_URL` 和 `BLOB_READ_WRITE_TOKEN`。通过 Vercel Storage 连接的资源通常会自动注入对应变量。
3. 将仓库导入 Vercel 并部署。`vercel.json` 已配置 Vite 构建、`dist` 输出目录和 SPA 路由回退。

账户、会话和照片元数据存入 Neon；照片原图存入私有 Blob，并由经过登录校验的 API 读取。首次 API 请求会自动初始化数据库表。

### 迁移现有 SQLite 相册

仓库中的 `data/heart-memories.sqlite` 不会提交到 Git，也不会由 Vercel 自动获得。配置好 Neon 与私有 Blob 凭据后，在包含原 SQLite 文件的本地项目目录运行：

```bash
npm run migrate:sqlite
```

脚本会复制账户和照片、上传原图，并保留密码哈希；迁移后用户需要在新域名重新登录。迁移不会删除或修改本地 SQLite 文件，可在数据库和照片确认无误前继续留作备份。脚本支持重复运行，已存在的相册记录会跳过。

### Docker 自托管

Docker 运行方式仍可使用，但需要配置同一组 Neon 与私有 Blob 环境变量：

```bash
docker compose up -d --build
```

对公网提供服务时，请在前面配置 HTTPS 反向代理；生产环境默认启用安全登录 Cookie。

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATABASE_URL` | 无 | Neon Postgres 连接字符串 |
| `BLOB_READ_WRITE_TOKEN` | 无 | Vercel Blob 私有读写令牌 |
| `COOKIE_SECURE` | 生产环境开启 | 登录 Cookie 是否仅通过 HTTPS 发送 |

## 📁 项目结构

```
heart-memories/
├── api/[...path].mjs      # Vercel Serverless Function 入口
├── server/
│   ├── api.mjs            # 登录、相册与设置 API
│   └── database.mjs       # Neon Postgres 表与查询
├── src/
│   ├── app/              # 应用入口
│   ├── components/
│   │   ├── upload/       # 照片上传（支持拖拽）
│   │   ├── controls/     # 三维场景控制
│   │   └── gallery/      # 照片墙、照片卡片、详情弹窗
│   ├── services/
│   │   ├── api.ts        # 登录与 API 请求
│   │   ├── db.ts         # 相册 API 与 Blob 直传
│   │   └── photoService.ts # 照片管理服务
│   ├── three/
│   │   ├── layouts/      # 布局算法（螺旋星系等）
│   │   └── particles/    # 星空效果
│   ├── config/           # 自动布局配置
│   ├── stores/           # Zustand 状态管理
│   ├── types/            # TypeScript 类型定义
├── dist/                 # 生产构建产物
├── server/index.mjs      # 本地/容器 HTTP 服务入口
├── scripts/migrate-to-vercel.mjs # SQLite 到 Neon/Blob 迁移
├── vercel.json           # Vercel 构建与 SPA 路由
├── Dockerfile            # 云服务器镜像
├── compose.yaml          # 持久化部署配置
└── README.md
```

## 🔧 技术栈

- **React 18** + **TypeScript** - 现代化前端框架
- **Vite 6** - 极速开发体验
- **Three.js** + **React Three Fiber** - 三维渲染
- **Zustand** - 轻量级状态管理
- **Neon Postgres** - 账户、登录会话、照片信息和缩略图
- **Vercel Blob 私有存储** - 相册原图

## 📊 配置说明

### 布局配置 (`src/config/layout.config.ts`)
```typescript
{
  auto: { thresholds: { ringMax: 20, heartMax: 99, sphereMax: 499 } },
  spiral: { radius: 10, turns: 4, arms: 3 },
  // ...
}
```

## 🔒 隐私保护

- ✅ 账号密码使用 scrypt 哈希，登录 Cookie 设置 HttpOnly
- ✅ 忘记密码时通过账号和绑定手机号匹配重置，不发送短信验证码；手机号匹配不能证明号码持有权
- ✅ 照片按账户隔离；JPG、PNG、WebP 原样保存，其他可解码图片自动转为 JPG
- ✅ 不调用云端图像识别服务
- ✅ 原图保存在私有 Blob，照片 API 按账户会话授权读取
- ✅ 账户和照片元数据保存在 Postgres
- ✅ 用户可随时清空账户相册

## 🌐 浏览器支持

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## 📈 性能优化

- 三维场景按需加载
- 支持减少动画模式（`prefers-reduced-motion`）

## 🔄 功能清单

### ✅ 已完成
- [x] 照片上传（拖拽/点击）
- [x] 账户登录与云端照片存储
- [x] 多设备相册同步
- [x] 螺旋星系布局
- [x] 圆形布局
- [x] 爱心布局
- [x] 球体布局
- [x] 电影胶片风格边框
- [x] 宇宙星空背景
- [x] 漂浮粒子效果
- [x] 自动旋转
- [x] 照片详情查看
- [x] 键盘导航（← → Esc）
- [x] 响应式设计

### 📋 计划中
- [ ] 更多布局效果
- [ ] 照片文件夹管理
- [ ] 相册分享功能
- [ ] 视频导出
- [ ] PWA 离线支持

## 🎯 使用指南

1. **首次打开**：显示空相册，可点击「选择照片」开始创建收藏
2. **添加照片**：点击「添加照片」按钮，或拖拽图片到页面
3. **浏览照片**：
   - 鼠标拖动旋转视角
   - 滚轮缩放
   - 点击照片查看详情
   - 展示形状仅根据照片数量自动变化，不提供手动布局或主题选择
4. **删除照片**：照片卡片上的删除按钮，或大图下方「删除这张照片」
5. **清空相册**：照片墙右上角「清空相册」按钮

## 📝 开发日志

### 2026-10-21
- 默认展示照片墙，三维展示作为可选视图
- 原图 Blob 与缩略图保存在 IndexedDB，支持刷新后恢复
- 增加批量导入、单张删除、清空相册和大图浏览
- 移除启动时依赖的远程示例照片

### 2026-10-22
- 增加账户注册、登录和跨设备共享相册
- 账户、会话和照片迁移到服务器 SQLite 数据库
- 增加 Docker Compose 持久化部署

---

**Heart Memories** — 让每一张照片都在宇宙中闪耀 ✨
