import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import membersRouter from "./members.js";
import uploadRouter from "./upload.js";
import dashboardRouter from "./dashboard.js";
import safetyCampaignsRouter from "./safety-campaigns.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(membersRouter);
router.use(uploadRouter);
router.use(dashboardRouter);
router.use("/safety-campaigns", safetyCampaignsRouter);

export default router;
