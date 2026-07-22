// ── Generation Telemetry — in-memory metrics collection ──
// Read-only observer. Never influences generation. Zero external dependencies.

interface StageTimer {
  start: number;
  end: number;
  duration: number;
}

export interface AiCallRecord {
  stage: string;
  durationMs: number;
  promptChars: number;
  completionChars: number;
  completed: boolean;
  jsonRepaired: boolean;
}

export interface TaskFailure {
  taskName: string;
  stage: string;
  error: string;
}

export interface TelemetryReport {
  totalTimeMs: number;
  stageTimings: Record<string, number>;
  aiCalls: AiCallRecord[];
  retryCount: number;
  regenerations: number;
  recoveredTasks: number;
  unrecoveredTasks: number;
  taskFailures: TaskFailure[];
  metrics: Record<string, number>;
  warnings: string[];
}

export class GenerationTelemetry {
  private startTime: number;
  private timers: Map<string, { start: number; end: number }> = new Map();
  private aiCallRecords: AiCallRecord[] = [];
  private retries = 0;
  private regenCount = 0;
  private recoveredCount = 0;
  private unrecoveredCount = 0;
  private taskFailureList: TaskFailure[] = [];
  private metricValues: Map<string, number> = new Map();
  private warningMessages: string[] = [];

  constructor() {
    this.startTime = Date.now();
  }

  startTimer(name: string): void {
    this.timers.set(name, { start: Date.now(), end: 0 });
  }

  endTimer(name: string): void {
    const t = this.timers.get(name);
    if (t) t.end = Date.now();
  }

  recordAiCall(record: AiCallRecord): void {
    this.aiCallRecords.push(record);
  }

  recordMetric(key: string, value: number): void {
    this.metricValues.set(key, value);
  }

  recordCounter(name: string): void {
    const current = this.metricValues.get(name) ?? 0;
    this.metricValues.set(name, current + 1);
  }

  recordWarning(message: string): void {
    this.warningMessages.push(message);
  }

  recordRetry(component: string): void {
    this.retries++;
    this.warningMessages.push(`retry:${component}`);
  }

  recordRegeneration(component: string): void {
    this.regenCount++;
  }

  recordTaskFailure(taskName: string, stage: string, error: string): void {
    this.taskFailureList.push({ taskName, stage, error });
  }

  recordRecovery(): void {
    this.recoveredCount++;
  }

  recordUnrecovered(): void {
    this.unrecoveredCount++;
  }

  generateReport(): TelemetryReport {
    const stageTimings: Record<string, number> = {};
    for (const [name, timer] of this.timers) {
      stageTimings[name] = timer.end > timer.start ? timer.end - timer.start : 0;
    }

    const metrics: Record<string, number> = {};
    for (const [k, v] of this.metricValues) {
      metrics[k] = v;
    }

    return {
      totalTimeMs: Date.now() - this.startTime,
      stageTimings,
      aiCalls: this.aiCallRecords,
      retryCount: this.retries,
      regenerations: this.regenCount,
      recoveredTasks: this.recoveredCount,
      unrecoveredTasks: this.unrecoveredCount,
      taskFailures: this.taskFailureList,
      metrics,
      warnings: this.warningMessages,
    };
  }
}
