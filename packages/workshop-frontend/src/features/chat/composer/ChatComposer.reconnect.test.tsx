// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
// qyvr patch 4 (QYVR-152, QYVR-153): a send made after the session was dropped while idle waits for
// the new session's overseer and goes exactly once; the Send button and Enter share one enabled state.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer, PublicApi } from "@gadgets/workshop-shared/api";

const state = vi.hoisted(() => ({ toast: vi.fn(), attachments: [] as unknown[] }));
vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: state.toast }),
}));
vi.mock("./attachments/useComposerAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attachments/useComposerAttachments")>()),
  useComposerAttachments: () => ({
    attachments: state.attachments, addFiles: () => {}, clearSentAttachments: () => {}, removeAttachment: () => {},
  }),
}));
vi.mock("../../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }));
vi.mock("../../../useVendorBranding", () => ({ useVendorBranding: () => new Map() }));
vi.mock("../../../GatekeeperModal", () => ({ default: () => null }));

import { ChatComposer } from "./ChatComposer";
import { RpcContext } from "../../../RpcContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

type Send = Parameters<typeof ChatComposer>[0]["onSend"];
type Session = { stub: RpcStub<PublicApi>; connectionLost: boolean };

// The session patch 3 dropped while idle: its next call is answered by a 1012 close.
const droppedSession = (): Session => ({
  stub: { ping: () => Promise.reject(new Error("Peer closed WebSocket")) } as unknown as RpcStub<PublicApi>,
  connectionLost: false,
});
const liveSession = (): Session => ({
  stub: { ping: () => Promise.resolve() } as unknown as RpcStub<PublicApi>,
  connectionLost: false,
});

describe("ChatComposer after an idle pause (qyvr patch 4)", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.useRealTimers();
    state.toast.mockClear();
    state.attachments = [];
  });

  const render = async (session: Session, overseer: RpcStub<Overseer>, onSend: Send) => {
    await act(async () => root.render(
      <RpcContext.Provider value={session}>
        <ChatComposer
          createCapsuleGatekeeper={async () => null}
          getOverseer={useOverseer(overseer)}
          onSend={onSend}
          isAgentActive={false}
          models={[]}
          selectedModel={{ id: "model-a" }}
          onModelChange={() => {}}
        />
      </RpcContext.Provider>,
    ));
  };
  // One getOverseer per overseer, as ChatInterface's useCallback([overseer]) gives.
  const sources = new Map<RpcStub<Overseer>, () => RpcStub<Overseer>>();
  const useOverseer = (o: RpcStub<Overseer>) => sources.get(o) ?? sources.set(o, () => o).get(o)!;

  const mount = () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  };
  const textarea = () => container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
  const button = () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
  const type = async (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const press = async (via: "enter" | "button") => act(async () => {
    if (via === "enter") textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    else button().click();
    await Promise.resolve();
  });

  it.each(["enter", "button"] as const)(
    "a send through %s on a session dropped mid-idle waits for the reconnect and arrives exactly once",
    async (via) => {
      mount();
      const oldOverseer = { id: "old" } as unknown as RpcStub<Overseer>;
      const newOverseer = { id: "new" } as unknown as RpcStub<Overseer>;
      const oldSend = vi.fn<Send>(async () => {});
      const newSend = vi.fn<Send>(async () => {});
      const dropped = droppedSession();
      await render(dropped, oldOverseer, oldSend);
      await type("Ship the report");
      expect(button().disabled).toBe(false);

      await press(via);
      // The ping found the session gone: the connection manager is reconnecting.
      const replacement = { stub: liveSession().stub, connectionLost: true };
      await render(replacement, oldOverseer, oldSend);
      expect(container.textContent).toContain("Reconnecting");
      // One enabled state while the send waits: the button is disabled and Enter adds nothing.
      expect(button().disabled).toBe(true);
      await press("enter");
      await press("button");
      expect(oldSend).not.toHaveBeenCalled();

      // The new session is proven, then its overseer is opened.
      await render({ ...replacement, connectionLost: false }, oldOverseer, oldSend);
      expect(oldSend).not.toHaveBeenCalled();
      await render({ ...replacement, connectionLost: false }, newOverseer, newSend);
      await act(async () => { await Promise.resolve(); });

      expect(oldSend).not.toHaveBeenCalled();
      expect(newSend).toHaveBeenCalledTimes(1);
      expect(newSend).toHaveBeenCalledWith("Ship the report", "model-a", undefined, undefined, undefined);
      expect(container.textContent).not.toContain("Connection hiccup");
      expect(container.textContent).not.toContain("Reconnecting");
      // Not left looking disabled: the next message can go through either path.
      await type("And the summary");
      expect(button().disabled).toBe(false);
      await press(via === "enter" ? "button" : "enter");
      expect(newSend).toHaveBeenCalledTimes(2);
    },
  );

  it("a send on a live session goes at once, once", async () => {
    mount();
    const overseer = {} as RpcStub<Overseer>;
    const onSend = vi.fn<Send>(async () => {});
    await render(liveSession(), overseer, onSend);
    await type("Hello");
    await press("button");
    await act(async () => { await Promise.resolve(); });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("when no new session's overseer arrives, the send says it was not sent instead of hanging", async () => {
    vi.useFakeTimers();
    mount();
    const overseer = {} as RpcStub<Overseer>;
    const onSend = vi.fn<Send>(async () => {});
    await render(droppedSession(), overseer, onSend);
    await type("Hello");
    await press("enter");
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(onSend).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connection hiccup");
    expect(button().disabled).toBe(false);
  });

  it("Enter does nothing whenever the button is disabled (one enabled state)", async () => {
    mount();
    const onSend = vi.fn<Send>(async () => {});
    // An attachment still uploading disables the button; before patch 4, Enter took its own path.
    state.attachments = [{ id: "a1", blob: new Blob(["x"]), mimeType: "text/plain", name: "notes.txt", uploadState: "uploading" }];
    await render(liveSession(), {} as RpcStub<Overseer>, onSend);
    await type("Hello");
    expect(button().disabled).toBe(true);
    await press("enter");
    expect(onSend).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
  });
});
