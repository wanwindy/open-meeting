# open-meeting MVP

这个仓库当前按《项目设计文档》的 Phase 1 和 Phase 2 落地 MVP，目标是先打通腾讯会议到钉钉的桥接链路。

当前范围：

- Worker 主链路：会话编排、平台 Agent、音视频管道、健康监控
- 最小控制面：节点注册、健康心跳、内存会话存储、最小调度器、会话 REST API
- 基础设施：Docker、WireGuard 模板、gRPC 协议

当前明确不做：

- 控制平面鉴权
- 多租户和配额
- 凭证加密存储
- 代理池和反检测策略

## 目录

- `apps/worker`: Node.js/TypeScript Worker，负责桥接会话执行
- `apps/control-plane`: Go 最小控制面，提供节点注册、心跳、简单调度和会话 API
- `proto/worker.proto`: Worker gRPC 协议
- `infra/docker`: 容器镜像与本地编排
- `infra/wireguard`: Overlay 网络配置模板

## 本地开发

1. 安装 Node.js 24+ 和 Go 1.24+
2. 在仓库根目录执行 `npm install`
3. 构建 Worker：`npm run build --workspace @open-meeting/worker`
4. 首次在新环境构建 control-plane 前，先进入 `apps/control-plane` 执行 `go mod tidy`
5. 然后执行 `go build ./cmd/server`
6. 参考 `infra/docker/docker-compose.yml` 在 Linux 宿主机启动容器环境

## MVP 运行方式

MVP 提供两种入口：

- gRPC Worker 服务：供后续控制面调度
- 本地 CLI：直接读取会话 JSON，快速发起腾讯 -> 钉钉桥接

## 运行示例

Worker 构建：

```bash
npm install
npm run build --workspace @open-meeting/worker
```

本地 dry-run：

```bash
cd apps/worker
node dist/cli/run-local-session.js config/tencent-to-dingtalk.session.example.json
```

启动 Worker gRPC 服务：

```bash
cd apps/worker
export WORKER_GRPC_TOKEN=dev-worker-token
node dist/main.js
```

如果要让 control-plane 通过 Docker 网络访问 Worker，可以把相同的 `WORKER_GRPC_TOKEN` 配到调用方 metadata 里；默认不再把 `50051` 暴露到宿主机。

当前默认示例里，control-plane 使用 `CONTROL_PLANE_WORKER_TOKEN` 连接 Worker；如果未单独设置，会回退读取 `WORKER_GRPC_TOKEN`。

如果 Worker 需要跨主机或跨网络暴露 gRPC，可以额外挂载证书并配置：

```bash
export WORKER_GRPC_TLS_CERT_PATH=/run/secrets/worker.crt
export WORKER_GRPC_TLS_KEY_PATH=/run/secrets/worker.key
```

如需开启双向 TLS，再补充：

```bash
export WORKER_GRPC_TLS_CA_PATH=/run/secrets/ca.crt
export WORKER_GRPC_TLS_REQUIRE_CLIENT_CERT=true
```

## 当前边界

- `apps/worker/config/platforms.json` 里的选择器是 MVP 初版配置，目的是把 Agent 结构和可配置面先搭起来
- 真正联调腾讯会议和钉钉 Web 端时，需要在 Linux 宿主机里根据实际 DOM 再微调这些选择器
- 视频链路依赖 `Xvfb + FFmpeg + v4l2loopback`，音频链路依赖 `PulseAudio`
- `apps/control-plane` 现在提供最小可用会话 API，但仍是内存存储；重启后会话历史不会保留
- 控制面仍不包含鉴权、多租户、凭证管理、配额和数据库持久化

## 控制面 MVP API

当前控制面已提供：

- `POST /v1/sessions`：选择在线 Worker 并发起桥接会话
- `GET /v1/sessions`：列出当前内存中的会话记录，支持 `?status=BRIDGING`
- `GET /v1/sessions/:id`：获取单个会话详情，并尽量向 Worker 刷新一次实时状态
- `DELETE /v1/sessions/:id`：停止指定会话

示例：

```bash
curl -X POST http://localhost:8080/v1/sessions \
  -H "content-type: application/json" \
  -d '{
    "source": {
      "platform": "tencent",
      "meeting_id": "888-888-888",
      "display_name": "Open Meeting Bridge A"
    },
    "target": {
      "platform": "dingtalk",
      "meeting_id": "vc_abcdef",
      "display_name": "Open Meeting Bridge B"
    },
    "options": {
      "dry_run": true,
      "enable_audio": true,
      "enable_video": true
    }
  }'
```

## Linux 视频前置条件

真实视频桥接依赖宿主机预先创建 `v4l2loopback` 设备，Worker 现在会在缺设备时明确报错，而不是把所有会话都硬绑到固定 `/dev/video10` 和 `/dev/video11`。

宿主机示例：

```bash
sudo modprobe v4l2loopback devices=4 video_nr=10,11,12,13
```

容器示例：

1. 先使用基础版 [docker-compose.yml](/D:/open-meeting/infra/docker/docker-compose.yml) 启动；基础配置默认不声明视频设备。
2. 真实视频桥接时，再叠加 [docker-compose.video.override.example.yml](/D:/open-meeting/infra/docker/docker-compose.video.override.example.yml) 里的 `WORKER_VIDEO_DEVICES` 和设备映射。
3. 一旦声明了 `WORKER_VIDEO_DEVICES`，Worker 启动时会对这些设备做 fail-fast 检查，缺任何一个都会直接退出并提示宿主机先加载 `v4l2loopback`。

另外，Worker 现在会为每个会话动态分配独立 Xvfb display，并在 display 就绪后再启动浏览器，避免并发串流和冷启动失败。

由于当前开发环境缺少 Linux 音视频设备和 Go 工具链，实际联调建议在 Linux 宿主机或具备 `/dev/video*`、PulseAudio、Xvfb 的容器环境中进行。
