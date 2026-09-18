import { Router, type IRouter } from "express";
import healthRouter from "./health";
import membersRouter from "./members";
import uploadRouter from "./upload";
import dashboardRouter from "./dashboard";
import safetyCampaignsRouter from "./safety-campaigns";

const router: IRouter = Router();

router.use(healthRouter);
router.use(membersRouter);
router.use(uploadRouter);
router.use(dashboardRouter);
router.use("/safety-campaigns", safetyCampaignsRouter);

export default router;
