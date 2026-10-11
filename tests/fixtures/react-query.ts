import React, { Component, createElement as h, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { FlareProvider, useQuery } from "../../packages/flare/src/sdk/react";
import { FlareError, reference } from "../../packages/flare/src/sdk/protocol";
const listeners = new Map<
  string,
  { next: (v: number) => void; error: (e: FlareError) => void }
>();
let registrations = 0,
  disposals = 0,
  args: {} | "skip" = {};
const client: any = {
  onUpdate(ref: any, a: any, next: any, error: any) {
    const key = ref.path + JSON.stringify(a);
    registrations++;
    listeners.set(key, { next, error });
    return () => {
      listeners.delete(key);
    };
  },
  dispose() {
    disposals++;
  },
};
const ref = reference<{}, number>("counter/get", "query");
function Value() {
  const value = useQuery(ref, args);
  return h(
    "p",
    { id: "value" },
    value === undefined ? "Loading" : String(value),
  );
}
class Boundary extends Component<any, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error
      ? h("p", { id: "error" }, this.state.error.message)
      : this.props.children;
  }
}
const root = createRoot(document.getElementById("root")!);
const result = document.getElementById("result")!;
const proof: string[] = [];
const assert = (condition: any, message: string) => {
  if (!condition) throw Error(message);
};
const text = () => document.getElementById("value")?.textContent;
const wait = async (test: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out");
};
const render = () =>
  flushSync(() =>
    root.render(
      h(
        StrictMode,
        null,
        h(FlareProvider, { client, children: h(Boundary, null, h(Value)) }),
      ),
    ),
  );
try {
  render();
  await wait(() => listeners.size === 1);
  assert(text() === "Loading", "Initial result must be loading");
  listeners.values().next().value!.next(7);
  await wait(() => text() === "7");
  listeners.values().next().value!.next(8);
  await wait(() => text() === "8");
  proof.push("Initial snapshot and updates via one useQuery");
  listeners
    .values()
    .next()
    .value!.error(new FlareError("LIVE_DISCONNECTED", "Reconnect"));
  await new Promise((r) => setTimeout(r, 10));
  assert(text() === "8", "Reconnect lost current data");
  proof.push("Reconnect keeps snapshot");
  const before = registrations;
  args = "skip";
  render();
  assert(text() === "Loading", "Skip leaked previous value");
  await wait(() => listeners.size === 0);
  assert(registrations === before, "Skip created a subscription");
  proof.push("Skip unsubscribes without requests");
  args = {};
  render();
  await wait(() => listeners.size === 1);
  assert(text() === "Loading", "Resume exposed previous cache");
  listeners.values().next().value!.next(9);
  await wait(() => text() === "9");
  listeners
    .values()
    .next()
    .value!.error(new FlareError("AUTH_CHANGED", "Identity changed"));
  await wait(() => !!document.getElementById("error"));
  assert(
    !document.getElementById("value"),
    "Identity change leaked previous data",
  );
  proof.push("Identity error clears value and reaches boundary");
  flushSync(() => root.unmount());
  assert(listeners.size === 0, "Unmount leaked subscriptions");
  assert(disposals === 0, "Provider disposed application client");
  proof.push("StrictMode/unmount clean up without disposing owned client");
  result.textContent = "PASS: " + proof.join(" · ");
} catch (error) {
  result.textContent = "FAIL: " + String(error);
}
