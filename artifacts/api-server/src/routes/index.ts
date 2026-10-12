import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatbotRouter from "./chatbot";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chatbotRouter);

export default router;
