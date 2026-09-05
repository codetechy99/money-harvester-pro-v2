import { Router, type IRouter } from "express";
import healthRouter from "./health";
import brokerRouter from "./broker";
import dashboardRouter from "./dashboard";
import engineRouter from "./engine";
import journalRouter from "./journal";
import riskRouter from "./risk";

const router: IRouter = Router();

router.use(healthRouter);
router.use(brokerRouter);
router.use(dashboardRouter);
router.use(engineRouter);
router.use(journalRouter);
router.use(riskRouter);

export default router;
