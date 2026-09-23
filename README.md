# 撤离清点服务

服务接收撤离批次、人员名单和集合点到达事件。`src/contracts.js` 提供批次及到达分类常量，`src/server.js` 是 Express 入口，SQLite 文件应保存在 `.data/` 目录中。

运行 `npm test` 执行基础测试，使用 `docker build -t evacuation-muster .` 构建镜像，再通过 `docker run --rm -p 8080:8080 evacuation-muster` 启动。进程状态可由 `GET /health` 获取。

## 编译或构建

```bash
npm run build
```
