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
          await this.outputDispatcher.send({
            type: "reminder",
            content: {
              summary: schedule.content?.text ?? schedule.name,
              scheduleId: schedule.id,
              scheduleName: schedule.name,
              shouldOutput: true,
              outputType: "reminder"
            }
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
          status: nextRunAt ? "active" : "completed"
        });
        results.push({ id: schedule.id, mode: schedule.mode, nextRunAt, completed: !nextRunAt });
      }

      return results;
    } finally {
      this.running = false;
    }
  }
}
