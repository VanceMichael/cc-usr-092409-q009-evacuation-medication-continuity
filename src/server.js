import express from "express";
import { pathToFileURL } from "node:url";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_request, response) => response.json({ status: "ok", service: "evacuation-muster" }));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
}
