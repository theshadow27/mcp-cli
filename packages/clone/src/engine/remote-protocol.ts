/**
 * Git remote helper stdin/stdout line protocol parser and capability handler.
 *
 * Git writes commands to stdin; the helper writes responses to stdout.
 * This module implements the line protocol parsing, command batching,
 * and capability negotiation for git-remote-mcx.
 */

export interface RemoteHelperHandlers {
  list(forPush: boolean): Promise<string>;
  handleImport(refs: string[]): Promise<string>;
  handleExport(stdin: ReadableStream<Uint8Array>): Promise<string>;
}

export interface ProtocolOptions {
  marksDir: string;
  onError?: (message: string) => void;
}

/** Read a single line from a ReadableStream reader, stripping the trailing newline. */
async function readLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { remainder: string },
): Promise<string | null> {
  while (true) {
    const nlIndex = buffer.remainder.indexOf("\n");
    if (nlIndex !== -1) {
      const line = buffer.remainder.slice(0, nlIndex);
      buffer.remainder = buffer.remainder.slice(nlIndex + 1);
      return line;
    }

    const { done, value } = await reader.read();
    if (done) {
      // Return remaining data as final line if non-empty
      if (buffer.remainder.length > 0) {
        const last = buffer.remainder;
        buffer.remainder = "";
        return last;
      }
      return null;
    }

    buffer.remainder += new TextDecoder().decode(value);
  }
}

/** Write a string to stdout, encoding as UTF-8. */
async function writeLine(writer: WritableStreamDefaultWriter<Uint8Array>, data: string): Promise<void> {
  await writer.write(new TextEncoder().encode(data));
}

/** Known options that the helper supports. */
const SUPPORTED_OPTIONS = new Set(["verbosity"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the git remote helper protocol loop.
 *
 * Reads commands from stdin line-by-line, dispatches to the provided handlers,
 * and writes responses to stdout.
 */
export async function runProtocol(
  stdin: ReadableStream<Uint8Array>,
  stdout: WritableStream<Uint8Array>,
  handlers: RemoteHelperHandlers,
  options: ProtocolOptions,
): Promise<void> {
  const reader = stdin.getReader();
  const writer = stdout.getWriter();
  const buffer = { remainder: "" };
  const logError = options.onError ?? ((msg: string) => process.stderr.write(msg));

  try {
    while (true) {
      const line = await readLine(reader, buffer);

      // EOF or empty line = exit
      if (line === null || line === "") {
        return;
      }

      if (line === "capabilities") {
        const caps = [
          "import",
          "export",
          "refspec refs/heads/*:refs/mcx/*/heads/*",
          "option",
          `*import-marks ${options.marksDir}/marks`,
          `*export-marks ${options.marksDir}/marks`,
        ];
        await writeLine(writer, `${caps.join("\n")}\n\n`);
      } else if (line === "list" || line === "list for-push") {
        const forPush = line === "list for-push";
        try {
          const response = await handlers.list(forPush);
          await writeLine(writer, `${response}\n`);
        } catch (err) {
          logError(`git-remote-mcx: list failed: ${errorMessage(err)}\n`);
          await writeLine(writer, "\n");
          return;
        }
      } else if (line.startsWith("import ")) {
        // Batch import: collect all consecutive import lines
        const refs: string[] = [line.slice("import ".length)];

        while (true) {
          const nextLine = await readLine(reader, buffer);
          if (nextLine === null || !nextLine.startsWith("import ")) {
            // Put back non-import line by prepending to remainder
            if (nextLine !== null && nextLine !== "") {
              buffer.remainder = `${nextLine}\n${buffer.remainder}`;
            }
            break;
          }
          refs.push(nextLine.slice("import ".length));
        }

        try {
          const response = await handlers.handleImport(refs);
          await writeLine(writer, response);
        } catch (err) {
          logError(`git-remote-mcx: import failed: ${errorMessage(err)}\n`);
          await writeLine(writer, "done\n");
          return;
        }
      } else if (line === "export") {
        // For export, we pass the remaining stdin as a stream to the handler.
        // Create a new ReadableStream that feeds from our buffered reader.
        const exportStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            // First drain any buffered remainder
            if (buffer.remainder.length > 0) {
              controller.enqueue(new TextEncoder().encode(buffer.remainder));
              buffer.remainder = "";
            }
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          },
        });

        try {
          const response = await handlers.handleExport(exportStream);
          await writeLine(writer, response);
        } catch (err) {
          // Cancel the stream before releaseLock() fires in the finally block.
          // Without this, exportStream's pull() may call reader.read() after the
          // lock is released, causing a "reader not attached" TypeError under high
          // CPU contention (the race that caused the intermittent t5801-33 failure).
          await exportStream.cancel("handler-error");
          logError(`git-remote-mcx: export failed: ${errorMessage(err)}\n`);
          await writeLine(writer, "\n");
          return;
        }
      } else if (line.startsWith("option ")) {
        const rest = line.slice("option ".length);
        const spaceIdx = rest.indexOf(" ");
        const key = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);

        if (SUPPORTED_OPTIONS.has(key)) {
          await writeLine(writer, "ok\n");
        } else {
          await writeLine(writer, "unsupported\n");
        }
      } else {
        // Unknown command — ignore per git remote helper convention
        await writeLine(writer, "unsupported\n");
      }
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}
