/**
 * mcx mail — interagent message queue with POSIX mail semantics.
 *
 * Send:
 *   mcx mail -s "subject" recipient           Body from stdin
 *   echo "body" | mcx mail -s "subject" recipient
 *
 * Read:
 *   mcx mail -H                               Headers only (all)
 *   mcx mail -u <user>                        Read a specific user's mailbox
 *   mcx mail -H -u <user>                     Headers for a specific user
 *
 * Reply:
 *   mcx mail -r <msgnum> -s "subject"         Reply to message (body from stdin)
 *
 * Wait:
 *   mcx mail --wait                            Block until message arrives
 *   mcx mail --wait --timeout=180              With timeout (seconds)
 *   mcx mail --wait --for=<recipient>          Wait for specific recipient
 */

import type { IpcMethod, IpcMethodResult, MailMessage } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { parseFlags } from "../flags";
import { printError } from "../output";
import { readStdin } from "../parse";

const MAIL_HELP = `mcx mail — interagent message queue

Recipients are string role-names that identify a mailbox.
Common names: orchestrator, manager, implementer, reviewer, qa.
Use \`mcx mail -u <name>\` to read a specific mailbox by name.
Mailboxes are created implicitly on first send.

Usage:
  mcx mail -s "subject" <recipient>   Send a message (body from stdin)
  mcx mail -H                        List message headers
  mcx mail -u <user>                 Read a user's mailbox
  mcx mail -r <msgnum>               Reply to a message (body from stdin)
  mcx mail --wait [--timeout=N]      Block until a message arrives
  mcx mail --wait --for=<name>       Wait for mail to specific recipient

Options:
  -s <subject>      Message subject
  -H                Headers only (summary list)
  -u <user>         Read a specific user's mailbox
  -r <msgnum>       Reply to message number
  -N                Suppress header list
  --wait            Block until a message arrives
  --timeout=<sec>   Timeout for --wait (default: 180)
  --for=<name>      Filter --wait by recipient
  --from=<name>     Override sender identity
  -h, --help        Show this help
`;

export interface MailArgs {
  subject: string | undefined;
  headersOnly: boolean;
  user: string | undefined;
  replyTo: number | undefined;
  suppressHeaders: boolean;
  wait: boolean;
  timeout: number;
  forRecipient: string | undefined;
  recipient: string | undefined;
  from: string | undefined;
  error: string | undefined;
}

export interface MailDeps {
  ipcCall: <M extends IpcMethod>(method: M, params?: unknown) => Promise<IpcMethodResult[M]>;
  printError: (msg: string) => void;
  writeStdout: (msg: string) => void;
  writeStderr: (msg: string) => void;
  readStdin: () => Promise<string>;
  isTTY: boolean;
  defaultSender: string;
  exit: (code: number) => never;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: MailDeps = {
  ipcCall,
  printError,
  writeStdout: (msg) => process.stdout.write(msg),
  writeStderr: (msg) => process.stderr.write(msg),
  readStdin,
  isTTY: !!process.stdin.isTTY,
  defaultSender: defaultSenderName(),
  exit: (code) => process.exit(code),
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export function defaultSenderName(): string {
  if (process.env.CLAUDE === "1") {
    // Encode session identity from cwd basename
    const cwd = process.cwd();
    const base = cwd.split("/").pop() ?? "claude";
    return `claude-${base}`;
  }
  return process.env.USER ?? "unknown";
}

const mailFlagSpecs = {
  subject: { type: "string" as const, alias: "s" },
  "headers-only": { type: "boolean" as const, alias: "H" },
  user: { type: "string" as const, alias: "u" },
  "reply-to": { type: "number" as const, alias: "r" },
  "suppress-headers": { type: "boolean" as const, alias: "N" },
  wait: { type: "boolean" as const },
  timeout: { type: "number" as const },
  for: { type: "string" as const },
  from: { type: "string" as const },
};

/** Map generic parseFlags error messages to the domain-specific ones tests expect. */
function mapFlagError(err: string): string {
  if (err.includes("-s") && err.includes("requires")) return "-s requires a subject";
  if (err.includes("-u") && err.includes("requires")) return "-u requires a username";
  if (err.includes("-r") && err.includes("requires")) return "-r requires a message number";
  if (err.includes("--reply-to") && err.includes("requires")) return "-r requires a message number";
  if (err.includes("--timeout") && err.includes("requires")) return "--timeout requires a positive number";
  if (err.includes("--for") && err.includes("requires")) return "--for requires a recipient name";
  if (err.includes("--from") && err.includes("requires")) return "--from requires a sender name";
  return err;
}

export function parseMailArgs(args: string[]): MailArgs {
  const { flags, positionals, errors, help } = parseFlags(args, mailFlagSpecs);

  if (help) {
    return {
      subject: undefined,
      headersOnly: false,
      user: undefined,
      replyTo: undefined,
      suppressHeaders: false,
      wait: false,
      timeout: 180,
      forRecipient: undefined,
      recipient: undefined,
      from: undefined,
      error: "HELP",
    };
  }

  if (errors.length > 0) {
    return {
      subject: undefined,
      headersOnly: false,
      user: undefined,
      replyTo: undefined,
      suppressHeaders: false,
      wait: false,
      timeout: 180,
      forRecipient: undefined,
      recipient: undefined,
      from: undefined,
      error: mapFlagError(errors[0]),
    };
  }

  const subject = flags.subject as string | undefined;
  const headersOnly = (flags["headers-only"] as boolean | undefined) ?? false;
  const user = flags.user as string | undefined;
  const replyTo = flags["reply-to"] as number | undefined;
  const suppressHeaders = (flags["suppress-headers"] as boolean | undefined) ?? false;
  const wait = (flags.wait as boolean | undefined) ?? false;
  const timeout = (flags.timeout as number | undefined) ?? 180;
  const forRecipient = flags.for as string | undefined;
  const from = flags.from as string | undefined;
  const recipient = positionals[0] as string | undefined;

  // Post-validation: timeout must be positive
  if (flags.timeout !== undefined && timeout <= 0) {
    return {
      subject: undefined,
      headersOnly: false,
      user: undefined,
      replyTo: undefined,
      suppressHeaders: false,
      wait: false,
      timeout: 180,
      forRecipient: undefined,
      recipient: undefined,
      from: undefined,
      error: "--timeout requires a positive number",
    };
  }

  return {
    subject,
    headersOnly,
    user,
    replyTo,
    suppressHeaders,
    wait,
    timeout,
    forRecipient,
    recipient,
    from,
    error: undefined,
  };
}

export async function cmdMail(args: string[], deps?: Partial<MailDeps>): Promise<void> {
  const d: MailDeps = { ...defaultDeps, ...deps };
  const parsed = parseMailArgs(args);

  if (args.length === 0 || parsed.error === "HELP") {
    d.writeStderr(MAIL_HELP);
    return;
  }

  if (parsed.error) {
    d.printError(parsed.error);
    d.exit(1);
  }

  const sender = parsed.from ?? d.defaultSender;

  // -- Wait mode --
  if (parsed.wait) {
    await cmdWait(parsed, sender, d);
    return;
  }

  // -- Reply mode --
  if (parsed.replyTo !== undefined) {
    await cmdReply(parsed, sender, d);
    return;
  }

  // -- Send mode: has a recipient --
  if (parsed.recipient) {
    await cmdSend(parsed, sender, d);
    return;
  }

  // -- Read mode --
  await cmdRead(parsed, d);
}

async function cmdSend(parsed: MailArgs, sender: string, d: MailDeps): Promise<void> {
  let body: string | undefined;
  if (!d.isTTY) {
    body = await d.readStdin();
  }

  const result = (await d.ipcCall("sendMail", {
    sender,
    recipient: parsed.recipient,
    subject: parsed.subject,
    body: body || undefined,
  })) as { id: number };

  d.writeStdout(`${JSON.stringify(result)}\n`);
}

async function cmdReply(parsed: MailArgs, sender: string, d: MailDeps): Promise<void> {
  let body: string | undefined;
  if (!d.isTTY) {
    body = await d.readStdin();
  }
  if (!body) {
    d.printError("Reply body required (pipe via stdin)");
    d.exit(1);
  }

  const result = (await d.ipcCall("replyToMail", {
    id: parsed.replyTo,
    sender,
    body,
    subject: parsed.subject,
  })) as { id: number };

  d.writeStdout(`${JSON.stringify(result)}\n`);
}

async function cmdRead(parsed: MailArgs, d: MailDeps): Promise<void> {
  const result = (await d.ipcCall("readMail", {
    recipient: parsed.user,
    unreadOnly: !parsed.user,
    limit: 50,
  })) as { messages: MailMessage[] };

  if (result.messages.length === 0) {
    d.writeStderr("No mail.\n");
    return;
  }

  if (parsed.headersOnly || !parsed.suppressHeaders) {
    for (const msg of result.messages) {
      const read = msg.read ? " " : "N";
      const subj = msg.subject ?? "(no subject)";
      d.writeStdout(`${read} ${String(msg.id).padStart(4)} ${msg.sender.padEnd(16)} ${subj}\n`);
    }
  }

  if (!parsed.headersOnly && result.messages.length > 0) {
    // Show the first unread message body
    const first = result.messages.find((m) => !m.read) ?? result.messages[0];
    if (first.body) {
      d.writeStdout(`\n--- Message ${first.id} from ${first.sender} ---\n${first.body}\n`);
    }
    if (!first.read) {
      await d.ipcCall("markRead", { id: first.id });
    }
  }
}

async function cmdWait(parsed: MailArgs, _sender: string, d: MailDeps): Promise<void> {
  const deadline = d.now() + parsed.timeout * 1000;
  const recipient = parsed.forRecipient;

  while (d.now() < deadline) {
    const remaining = Math.ceil((deadline - d.now()) / 1000);
    const serverTimeout = Math.min(remaining, 30);
    if (serverTimeout <= 0) break;

    const result = (await d.ipcCall("waitForMail", {
      recipient,
      timeout: serverTimeout,
    })) as { message: MailMessage | null };

    if (result.message) {
      d.writeStdout(`${JSON.stringify(result.message)}\n`);
      return;
    }
  }

  d.writeStderr("Timeout: no mail received.\n");
  d.exit(1);
}
