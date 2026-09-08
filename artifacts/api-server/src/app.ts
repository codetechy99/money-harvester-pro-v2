import path from "node:path";
import fs from "node:fs";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const frontendPublicDir = path.resolve(
  import.meta.dirname,
  "../../money-harvester-pro/dist/public",
);

const hasFrontendBuild = fs.existsSync(path.join(frontendPublicDir, "index.html"));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (hasFrontendBuild) {
  app.use(express.static(frontendPublicDir, { index: "index.html" }));
} else {
  app.get("/", (_req, res) => {
    res.json({ service: "money-harvester-pro-api", status: "ok" });
  });
}
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api", router);

if (hasFrontendBuild) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
      return res.sendFile(path.join(frontendPublicDir, "index.html"));
    }
    return next();
  });
}

export default app;
