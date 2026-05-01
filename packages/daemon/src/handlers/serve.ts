import {
  IPC_ERROR,
  KillServeParamsSchema,
  RegisterServeParamsSchema,
  UnregisterServeParamsSchema,
} from "@mcp-cli/core";
import type { IpcMethod, Logger, ServeInstanceInfo } from "@mcp-cli/core";
import type { RequestHandler } from "../handler-types";
import { killPid } from "../process-util";

export class ServeHandlers {
  private readonly killPidFn: (pid: number, logger: Logger) => Promise<void>;

  constructor(
    private readonly serveInstances: Map<string, ServeInstanceInfo>,
    private readonly logger: Logger,
    killPidFn?: (pid: number, logger: Logger) => Promise<void>,
  ) {
    this.killPidFn = killPidFn ?? killPid;
  }

  /** Remove serve instances whose PID is no longer alive. */
  pruneStaleInstances(): void {
    for (const [id, info] of this.serveInstances) {
      try {
        process.kill(info.pid, 0);
      } catch {
        this.serveInstances.delete(id);
      }
    }
  }

  register(handlers: Map<IpcMethod, RequestHandler>): void {
    handlers.set("registerServe", async (params, _ctx) => {
      const { instanceId, pid, tools } = RegisterServeParamsSchema.parse(params);
      this.serveInstances.set(instanceId, { instanceId, pid, tools, startedAt: Date.now() });
      return { ok: true as const };
    });

    handlers.set("unregisterServe", async (params, _ctx) => {
      const { instanceId } = UnregisterServeParamsSchema.parse(params);
      this.serveInstances.delete(instanceId);
      return { ok: true as const };
    });

    handlers.set("listServeInstances", async (_params, _ctx) => {
      this.pruneStaleInstances();
      return [...this.serveInstances.values()];
    });

    handlers.set("killServe", async (params, _ctx) => {
      const { instanceId, pid, all, staleHours } = KillServeParamsSchema.parse(params ?? {});

      if (!instanceId && pid == null && !all && staleHours == null) {
        throw Object.assign(new Error("Specify instanceId, pid, all, or staleHours"), {
          code: IPC_ERROR.INVALID_PARAMS,
        });
      }

      this.pruneStaleInstances();

      const targets: ServeInstanceInfo[] = [];
      if (staleHours != null) {
        const cutoff = Date.now() - staleHours * 60 * 60 * 1000;
        for (const inst of this.serveInstances.values()) {
          if (inst.startedAt < cutoff) targets.push(inst);
        }
      } else if (all) {
        targets.push(...this.serveInstances.values());
      } else if (instanceId) {
        const inst = this.serveInstances.get(instanceId);
        if (!inst) {
          throw Object.assign(new Error(`Serve instance "${instanceId}" not found`), {
            code: IPC_ERROR.SERVER_NOT_FOUND,
          });
        }
        targets.push(inst);
      } else if (pid != null) {
        for (const inst of this.serveInstances.values()) {
          if (inst.pid === pid) targets.push(inst);
        }
        if (targets.length === 0) {
          throw Object.assign(new Error(`No serve instance with PID ${pid}`), {
            code: IPC_ERROR.SERVER_NOT_FOUND,
          });
        }
      }

      for (const inst of targets) {
        await this.killPidFn(inst.pid, this.logger);
        this.serveInstances.delete(inst.instanceId);
      }

      return { killed: targets.length };
    });
  }
}
