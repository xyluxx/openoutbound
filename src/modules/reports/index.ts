import type { EngineModule } from "../../core/operation.js";
import { runScheduleJob } from "./jobs/run-schedule.js";
import { getAttention } from "./operations/get-attention.js";
import { getReport } from "./operations/get-report.js";
import {
  createReportSchedule,
  deleteReportSchedule,
  listReportSchedules,
  runReportSchedule,
} from "./operations/schedules.js";
import { reportTools } from "./tools.js";

/**
 * Reports (spec 11.12): on-demand reports (reports.get), the attention queue (attention.get)
 * and scheduled reports delivered to notification channels (reports.schedules.*, job
 * reports.run_schedule). Reads other modules' tables directly; writes only `reports` and its
 * own `schedules` rows.
 */
export const module: EngineModule = {
  name: "reports",
  operations: [
    getReport,
    getAttention,
    createReportSchedule,
    listReportSchedules,
    deleteReportSchedule,
    runReportSchedule,
  ],
  tools: reportTools,
  jobs: [runScheduleJob],
};
