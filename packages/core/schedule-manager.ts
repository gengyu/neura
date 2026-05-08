import { RUNTIME_EVENT_TYPES, SCHEDULE_STATUSES, SOURCE_TYPES, TASK_STATUSES } from "../shared/types.ts";
import { buildOutputDecision } from "./output-decision.ts";
import { buildOutputRoute } from "./output-routing.ts";

export class ScheduleManager {
  constructor({ repository, runtime, outputDispatcher }) {
    this.repository = repository;
    this.runtime = runtime;
    this.outputDispatcher = outputDispatcher;
    this.running = false;
  }

  async processDueSchedules(now = new Date()) {
    if (this.running) return [];
    this.running = true;

    try {
      const dueSchedules = this.repository.getDueSchedules(now.toISOString());
      const results = [];

      for (const schedule of dueSchedules) {
        if (schedule.mode === "reminder") {
          const task = this.repository.createTask({
            sourceType: SOURCE_TYPES.SCHEDULE,
            sourceId: schedule.id,
            type: RUNTIME_EVENT_TYPES.SCHEDULE_REMINDER
          });
          const content = {
            summary: schedule.content?.text ?? schedule.name,
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            shouldOutput: true,
            outputType: "reminder"
          };
          const decision = buildOutputDecision({
            sourceType: SOURCE_TYPES.SCHEDULE,
            sourceId: schedule.id,
            eventType: RUNTIME_EVENT_TYPES.SCHEDULE_REMINDER,
            schedule
          });
          const route = buildOutputRoute({
            outputEvent: {
              sourceType: SOURCE_TYPES.SCHEDULE,
              sourceId: schedule.id,
              type: decision.outputType,
              priority: decision.priority
            },
            decision,
            repository: this.repository
          });
          await this.outputDispatcher.send({
            type: decision.outputType,
            sourceType: SOURCE_TYPES.SCHEDULE,
            sourceId: schedule.id,
            content,
            preferredPluginIds: route.preferredPluginIds
          });
          this.repository.finishTask(task.id, TASK_STATUSES.COMPLETED, {
            scheduleId: schedule.id,
            outputDecision: decision,
            outputRoute: route
          });
        } else if (schedule.mode === "input") {
          await this.runtime.input(schedule.content?.text ?? schedule.name, {
            pluginId: "scheduler-input",
            type: "event",
            metadata: { scheduleId: schedule.id, source: "scheduler" },
            internal: true
          });
        }

        const nextRunAt = schedule.intervalMs ? new Date(now.getTime() + Number(schedule.intervalMs)).toISOString() : null;
        this.repository.markScheduleRun(schedule.id, {
          nextRunAt: nextRunAt ?? schedule.runAt,
          status: nextRunAt ? SCHEDULE_STATUSES.ACTIVE : SCHEDULE_STATUSES.COMPLETED
        });
        results.push({ id: schedule.id, mode: schedule.mode, nextRunAt, completed: !nextRunAt });
      }

      return results;
    } finally {
      this.running = false;
    }
  }
}
