import { Box, Text } from "ink";
import React from "react";

export type AddServerTransport = "http" | "sse" | "stdio";
export type AddServerScope = "user" | "project";

export type AddServerStep = "transport" | "name" | "url" | "env" | "scope" | "confirm";

export const ADD_SERVER_STEPS: AddServerStep[] = ["transport", "name", "url", "env", "scope", "confirm"];

export interface AddServerState {
  step: AddServerStep;
  transport: AddServerTransport;
  name: string;
  url: string;
  env: string[];
  /** Buffer for the env var currently being typed. */
  envInput: string;
  scope: AddServerScope;
}

export function initialAddServerState(): AddServerState {
  return {
    step: "transport",
    transport: "http",
    name: "",
    url: "",
    env: [],
    envInput: "",
    scope: "user",
  };
}

interface ServerAddFormProps {
  state: AddServerState;
  /** Resolved config file path for the current scope — shown on the confirm step. */
  configPath?: string;
}

const TRANSPORT_OPTIONS: AddServerTransport[] = ["http", "sse", "stdio"];
const SCOPE_OPTIONS: AddServerScope[] = ["user", "project"];

export function ServerAddForm({ state, configPath }: ServerAddFormProps) {
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Text bold color="cyan">
        Add Server
      </Text>

      {state.step === "transport" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Transport:</Text>
          {TRANSPORT_OPTIONS.map((t) => (
            <Text key={t}>
              {t === state.transport ? <Text color="cyan">{"> "}</Text> : "  "}
              <Text bold={t === state.transport}>{t}</Text>
            </Text>
          ))}
          <Text dimColor>j/k select enter confirm esc cancel</Text>
        </Box>
      )}

      {state.step === "name" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Transport: <Text color="green">{state.transport}</Text>
          </Text>
          <Text>
            Name: {state.name}
            <Text dimColor>█</Text>
          </Text>
          <Text dimColor>type name enter confirm esc cancel</Text>
        </Box>
      )}

      {state.step === "url" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Transport: <Text color="green">{state.transport}</Text> | Name: <Text color="green">{state.name}</Text>
          </Text>
          <Text>
            {state.transport === "stdio" ? "Command" : "URL"}: {state.url}
            <Text dimColor>█</Text>
          </Text>
          <Text dimColor>type {state.transport === "stdio" ? "command" : "url"} enter confirm esc cancel</Text>
        </Box>
      )}

      {state.step === "env" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Transport: <Text color="green">{state.transport}</Text> | Name: <Text color="green">{state.name}</Text> |{" "}
            {state.transport === "stdio" ? "Cmd" : "URL"}: <Text color="green">{state.url}</Text>
          </Text>
          {state.env.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Env vars:</Text>
              {state.env.map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: env vars are append-only during form
                <Text key={i}>
                  {"  "}
                  {e}
                </Text>
              ))}
            </Box>
          )}
          <Text>
            Add env (KEY=VALUE): {state.envInput}
            <Text dimColor>█</Text>
          </Text>
          <Text dimColor>type KEY=VALUE enter add tab skip esc cancel</Text>
        </Box>
      )}

      {state.step === "scope" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Transport: <Text color="green">{state.transport}</Text> | Name: <Text color="green">{state.name}</Text>
          </Text>
          <Text>Scope:</Text>
          {SCOPE_OPTIONS.map((s) => (
            <Text key={s}>
              {s === state.scope ? <Text color="cyan">{"> "}</Text> : "  "}
              <Text bold={s === state.scope}>{s}</Text>
            </Text>
          ))}
          <Text dimColor>j/k select enter confirm esc cancel</Text>
        </Box>
      )}

      {state.step === "confirm" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Transport: <Text color="green">{state.transport}</Text>
          </Text>
          <Text>
            Name: <Text color="green">{state.name}</Text>
          </Text>
          <Text>
            {state.transport === "stdio" ? "Command" : "URL"}: <Text color="green">{state.url}</Text>
          </Text>
          {state.env.length > 0 && (
            <Text>
              Env: <Text color="green">{state.env.join(", ")}</Text>
            </Text>
          )}
          <Text>
            Scope: <Text color="green">{state.scope}</Text>
          </Text>
          {configPath && (
            <Text>
              Config: <Text dimColor>{configPath}</Text>
            </Text>
          )}
          <Text dimColor>enter save esc cancel</Text>
        </Box>
      )}
    </Box>
  );
}
