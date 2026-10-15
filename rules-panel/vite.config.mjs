import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readSnapshot } from "./server/snapshot.mjs";
import { localWorkspaceMiddleware } from "./server/local-workspace.mjs";

function policySnapshot() {
  const middleware = (server) => {
    server.middlewares.use(localWorkspaceMiddleware());
    server.middlewares.use("/policy-snapshot.json", async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end(
          JSON.stringify({
            error: "Tylko odczyt. Publikacja nie jest podłączona.",
          }),
        );
        return;
      }
      try {
        res.end(JSON.stringify(await readSnapshot()));
      } catch {
        res.statusCode = 503;
        res.end(
          JSON.stringify({
            error: "Nie można odczytać konfiguracji projektu.",
          }),
        );
      }
    });
  };
  return {
    name: "policy-snapshot",
    configureServer: middleware,
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "policy-snapshot.json",
        source: JSON.stringify(await readSnapshot({ mode: "hosted-preview" })),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), policySnapshot()],
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    cors: false,
    fs: { strict: true },
  },
  preview: { host: "127.0.0.1", port: 4318, strictPort: true, cors: false },
});
