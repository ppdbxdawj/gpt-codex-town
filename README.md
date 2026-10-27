# Codex Town

Codex Town 是“星糖庄园”的源码仓库。星糖庄园是本机运行的 macOS 3D 庄园应用，以只读方式呈现本机可访问的任务、自动化、成果和有限的任务过程；它不会执行任务、发送消息或上传本地数据。

## 功能

- 原庄园内的启用自动化小院、集中任务工坊、成果阅读与明确验收记录。
- 本机 Codex 日志中最近一轮的公开进展与工具类别，最多显示 12 项。
- 带采集时间的云端计划和结果快照。它们不是实时同步，云端执行过程不可读。
- 原生 macOS 应用壳、本地 Python 服务与本地 Three.js 运行时。

过程卡不会显示模型思考、提示词、命令参数、工具输出或完整执行记录。自动化展示的本机过程只按关联任务读取，不能证明该计划触发了这次执行。阅读、验收和成果馆记录只会在用户操作后改变。

默认庄园主人是程序化角色，不含任何个人模型或贴图。`public/assets/` 以及 GLB、FBX、WebP 文件均不随源码仓库发布。

## 构建与运行

需要 macOS 13+、Apple Silicon、Xcode Command Line Tools、Python 3.9+ 与 Node.js。项目级 `.npmrc` 固定使用 npm 公共源。

```zsh
npm ci --ignore-scripts
npm run prepare:vendor
zsh desktop/build-app.sh
open 星糖庄园.app
```

`prepare:vendor` 从锁定的依赖重建本地 Three.js 运行时，并生成相应的第三方许可文件。打包脚本会构建并临时签名原生应用。

## 验证

已验证的源码构建通过，Python 测试 47 项与 Node 测试 6 项均通过。可在本机重新运行：

```zsh
python3 -B -m unittest discover -s tests -v
node --test tests/test_schedule_village.mjs
```

## 第三方与许可证

第三方依赖与通知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本仓库的源码许可证尚未指定。
