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

import type { IpcMethod, MailMessage } from "@mcp-cli/core";
import { ipcCall } from "@mcp-cli/core";
import { printError } from "../output";
import { readStdin } from "../parse";

const MAIL_HELP = `mcx mail — interagent message queue

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
  ipcCall: (method: IpcMethod, params?: unknown) => Promise<unknown>;
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

export function parseMailArgs(args: string[]): MailArgs {
  let subject: string | undefined;
  let headersOnly = false;
  let user: string | undefined;
  let replyTo: number | undefined;
  let suppressHeaders = false;
  let wait = false;
  let timeout = 180;
  let forRecipient: string | undefined;
  let recipient: string | undefined;
  let from: string | undefined;
  let error: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      error = "HELP";
      break;
    }
    if (arg === "-s") {
      const next = args[++i];
      if (!next) {
        error = "-s requires a subject";
        break;
      }
      subject = next;
    } else if (arg === "-H") {
      headersOnly = true;
    } else if (arg === "-u") {
      const next = args[++i];
      if (!next) {
        error = "-u requires a username";
        break;
      }
      user = next;
    } else if (arg === "-r") {
      const next = args[++i];
      if (!next || Number.isNaN(Number(next))) {
        error = "-r requires a message number";
        break;
      }
      replyTo = Number(next);
    } else if (arg === "-N") {
      suppressHeaders = true;
    } else if (arg === "--wait") {
      wait = true;
    } else if (arg.startsWith("--timeout=")) {
      const val = Number(arg.slice("--timeout=".length));
      if (Number.isNaN(val) || val <= 0) {
        error = "--timeout requires a positive number";
        break;
      }
      timeout = val;
    } else if (arg === "--timeout") {
      const next = args[++i];
      if (!next || Number.isNaN(Number(next)) || Number(next) <= 0) {
        error = "--timeout requires a positive number";
        break;
      }
      timeout = Number(next);
    } else if (arg.startsWith("--for=")) {
      forRecipient = arg.slice("--for=".length);
    } else if (arg === "--for") {
      const next = args[++i];
      if (!next) {
        error = "--for requires a recipient name";
        break;
      }
      forRecipient = next;
    } else if (arg === "--from") {
      const next = args[++i];
      if (!next) {
        error = "--from requires a sender name";
        break;
      }
      from = next;
    } else if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
    } else if (!arg.startsWith("-")) {
      recipient = arg;
    }
  }

  return { subject, headersOnly, user, replyTo, suppressHeaders, wait, timeout, forRecipient, recipient, from, error };
}

export async function cmdMail(args: string[], deps?: Partial<MailDeps>): Promise<void> {
  const d: MailDeps = { ...defaultDeps, ...deps };
  const parsed = parseMailArgs(args);

  if (parsed.error === "HELP") {
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
