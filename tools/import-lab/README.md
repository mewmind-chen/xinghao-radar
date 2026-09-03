# Import Lab

本地运行的导入识别验证项目。它只调用 `packages/import-engine`，不写 Radar 数据库。

```bash
IMPORT_LAB_DEV_AUTH=true npm run import:lab
```

打开 `http://127.0.0.1:8090/import-lab/`。如需通过现有 Tunnel 暴露，增加一条高于 Radar 总规则的路径规则：

```yaml
- hostname: radar.newmindchen.com
  path: ^/import-lab(?:/.*)?$
  service: http://127.0.0.1:8090
```

公网模式不要设置 `IMPORT_LAB_DEV_AUTH=true`。Lab 会将当前请求的 Radar 会话转交给 `RADAR_AUTH_BRIDGE_URL`（默认 `http://127.0.0.1:8082/api/import-lab/access`）验证。

主模型默认是 `google/gemini-3.8-flash`，对照模型通过 `IMPORT_LAB_COMPARE_MODEL` 配置；未配置时对比模式会明确报错。

## 接入 Radar

Lab fixture 与业务样本验收通过后，再给 Radar 服务进程设置：

```bash
IMPORT_ENGINE_V2_ENABLED=true \
OPENROUTER_API_KEY=你的服务端密钥 \
IMPORT_MODEL=google/gemini-3.8-flash \
npm run dev
```

开关关闭或未设置时，Radar 仍使用旧的兼容抽取路径；新引擎不会自动调用
8787 Platform。`confirmImport`、重复校验、权限校验、预览和事务写库均保留在 Radar。
