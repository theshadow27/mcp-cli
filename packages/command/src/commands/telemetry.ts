/**
 * mcx telemetry — control anonymous usage telemetry.
 *
 * Usage:
 *   mcx telemetry            Show current telemetry status
 *   mcx telemetry status     Show current telemetry status
 *   mcx telemetry on         Enable telemetry
 *   mcx telemetry off        Disable telemetry
 */

import { isTelemetryEnabled, readCliConfig, writeCliConfig } from "@mcp-cli/core";
import { printError } from "../output";

export function cmdTelemetry(args: string[]): void {
  const sub = args[0] ?? "status";

  switch (sub) {
    case "status": {
      const enabled = isTelemetryEnabled();
      const envDisabled = process.env.MCX_NO_TELEMETRY === "1";
      if (envDisabled) {
        console.log("Telemetry: disabled (MCX_NO_TELEMETRY=1)");
      } else {
        console.log(`Telemetry: ${enabled ? "enabled" : "disabled"}`);
      }
      console.error("\nSee PRIVACY.md for details on what is collected.");
      break;
    }

    case "on": {
      const config = readCliConfig();
      writeCliConfig({ ...config, telemetry: true });
      console.log("Telemetry enabled.");
      break;
    }

    case "off": {
      const config = readCliConfig();
      writeCliConfig({ ...config, telemetry: false });
      console.log("Telemetry disabled.");
      break;
    }

    default:
      printError(`Unknown telemetry subcommand: ${sub}`);
      console.error("Usage: mcx telemetry [on|off|status]");
      process.exit(1);
  }
}
