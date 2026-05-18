// Pin NO_COLOR before any module captures process.stdout.isTTY.
// Prevents ANSI escape codes from leaking into assertions when bun test
// runs under a PTY (interactive terminal). See #2016.
process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";
