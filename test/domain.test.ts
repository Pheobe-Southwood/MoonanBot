import { describe, expect, it } from "vitest";
import { archiveThreshold, formatAvailableActions, listAvailableActions, notificationFor, segmentsMention, validateDuration, validateWait } from "../src/domain/behavior.js";
import { defaultRuntime, defaultSettings } from "../src/domain/defaults.js";
import type { PhoneState, RuntimeState } from "../src/domain/types.js";

function withPhone(runtime: RuntimeState, phone: PhoneState): RuntimeState {
  return { ...runtime, phone };
}

const chatTarget = { platform: "onebot" as const, kind: "private" as const, id: "42" };

describe("behavior domain", () => {
  it("reveals actions progressively from the phone state", () => {
    const closed = defaultRuntime();
    expect(listAvailableActions(closed).map((item) => item.id)).toEqual(["idle", "sleep", "open_phone"]);

    const home = withPhone(closed, { kind: "home" });
    expect(listAvailableActions(home).map((item) => item.id)).toEqual(["idle", "sleep", "view_contacts", "close_phone"]);

    const contacts = withPhone(closed, { kind: "contacts" });
    expect(listAvailableActions(contacts).map((item) => item.id)).toEqual([
      "idle", "sleep", "view_contacts", "open_chat", "set_contact_importance", "close_phone",
    ]);

    const privateChat = withPhone(closed, { kind: "chat", target: chatTarget });
    expect(listAvailableActions(privateChat).map((item) => item.id)).toEqual([
      "idle", "sleep", "view_contacts", "load_history", "send_messages", "wait_messages", "set_contact_importance", "close_phone",
    ]);

    const groupChat = withPhone(closed, { kind: "chat", target: { ...chatTarget, kind: "group" as const } });
    const groupActions = listAvailableActions(groupChat).map((item) => item.id);
    expect(groupActions).not.toContain("set_contact_importance");
    expect(groupActions).toContain("wait_messages");
  });

  it("renders the action appendix from the current state", () => {
    const appendix = formatAvailableActions(listAvailableActions(defaultRuntime()));
    expect(appendix).toContain("接下来可用的动作:");
    expect(appendix).toContain("open_phone");
    expect(appendix).toContain("durationMinutes: number");
    expect(appendix).not.toContain("send_messages");
  });

  it("enforces configured idle and sleep duration bounds", () => {
    const settings = defaultSettings("token");
    expect(() => validateDuration("idle", 29, settings)).toThrow(/30/);
    expect(() => validateDuration("idle", 480, settings)).not.toThrow();
    expect(() => validateDuration("sleep", 961, settings)).toThrow(/960/);
  });

  it("enforces wait parameter rules", () => {
    const settings = defaultSettings("token");
    expect(validateWait({ durationSeconds: 10 }, settings)).toEqual({ mode: "seconds", seconds: 10 });
    expect(validateWait({ messageCount: 3 }, settings)).toEqual({ mode: "count", count: 3 });
    expect(() => validateWait({}, settings)).toThrow(/二选一/);
    expect(() => validateWait({ durationSeconds: 10, messageCount: 2 }, settings)).toThrow(/二选一/);
    expect(() => validateWait({ durationSeconds: 4 }, settings)).toThrow(/5 到 60/);
    expect(() => validateWait({ durationSeconds: 61 }, settings)).toThrow(/5 到 60/);
    expect(() => validateWait({ messageCount: 6 }, settings)).toThrow(/1 到 5/);
    expect(() => validateWait({ messageCount: 1.5 }, settings)).toThrow(/整数/);
  });

  it("implements all five importance levels and injectable wake probability", () => {
    expect(notificationFor("private", "priority_plus", true, () => 1, 0.5)).toEqual({ signal: "alarm", wakes: true, visibleOnPhone: true });
    expect(notificationFor("private", "priority", true, () => 0.49, 0.5).wakes).toBe(true);
    expect(notificationFor("private", "priority", true, () => 0.5, 0.5).wakes).toBe(false);
    expect(notificationFor("private", "normal", true, () => 0, 0.5)).toEqual({ signal: "vibration", wakes: false, visibleOnPhone: true });
    expect(notificationFor("private", "do_not_disturb", false, () => 0, 0.5)).toEqual({ signal: "none", wakes: false, visibleOnPhone: true });
    expect(notificationFor("private", "no_push", false, () => 0, 0.5)).toEqual({ signal: "none", wakes: false, visibleOnPhone: false });
    expect(notificationFor("group", "priority_plus", true, () => 0, 0.5)).toEqual({ signal: "vibration", wakes: false, visibleOnPhone: true });
    expect(notificationFor("group", "priority", false, () => 0, 0.5).signal).toBe("none");
  });

  it("maps group mentions onto the private signal rules", () => {
    expect(notificationFor("group", "priority_plus", true, () => 0, 0.5, true)).toEqual({ signal: "alarm", wakes: true, visibleOnPhone: true });
    expect(notificationFor("group", "priority", true, () => 0.49, 0.5, true).wakes).toBe(true);
    expect(notificationFor("group", "priority", true, () => 0.5, 0.5, true).wakes).toBe(false);
    expect(notificationFor("group", "normal", false, () => 0, 0.5, true)).toEqual({ signal: "vibration", wakes: true, visibleOnPhone: true });
    expect(notificationFor("group", "normal", true, () => 0, 0.5, true)).toEqual({ signal: "vibration", wakes: false, visibleOnPhone: true });
    expect(notificationFor("group", "do_not_disturb", false, () => 0, 0.5, true)).toEqual({ signal: "none", wakes: false, visibleOnPhone: true });
    expect(notificationFor("group", "no_push", false, () => 0, 0.5, true)).toEqual({ signal: "none", wakes: false, visibleOnPhone: false });
  });

  it("detects @ mentions including @all in message segments", () => {
    expect(segmentsMention([{ type: "at", data: { qq: "123" } }], "123")).toBe(true);
    expect(segmentsMention([{ type: "at", data: { qq: 123 } }], "123")).toBe(true);
    expect(segmentsMention([{ type: "at", data: { qq: "all" } }], "123")).toBe(true);
    expect(segmentsMention([{ type: "text", data: { text: "@123" } }], "123")).toBe(false);
    expect(segmentsMention([{ type: "at", data: { qq: "777" } }], "123")).toBe(false);
    expect(segmentsMention([{ type: "at", data: { qq: "all" } }], null)).toBe(false);
  });

  it("uses the smaller of the absolute and model-relative archive boundaries", () => {
    expect(archiveThreshold(272_000, 1_000_000)).toBe(272_000);
    expect(archiveThreshold(272_000, 128_000)).toBe(102_400);
    expect(archiveThreshold(272_000, 100_000, 0.7)).toBe(70_000);
    expect(() => archiveThreshold(1, 1, 2)).toThrow(/比例/);
  });
});
