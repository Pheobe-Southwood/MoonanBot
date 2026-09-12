import { describe, expect, it } from "vitest";
import { archiveThreshold, listAvailableActions, notificationFor, validateDuration } from "../src/domain/behavior.js";
import { defaultRuntime, defaultSettings } from "../src/domain/defaults.js";

describe("behavior domain", () => {
  it("reveals actions progressively from the phone state", () => {
    const closed = defaultRuntime();
    expect(listAvailableActions(closed).map((item) => item.id)).toEqual([
      "idle", "sleep", "set_contact_importance", "open_phone",
    ]);
    const home = { ...closed, phone: { kind: "home" as const } };
    expect(listAvailableActions(home).map((item) => item.id)).toContain("open_chat");
    expect(listAvailableActions(home).map((item) => item.id)).not.toContain("send_messages");
    const chat = { ...closed, phone: { kind: "chat" as const, target: { platform: "onebot" as const, kind: "private" as const, id: "42" } } };
    expect(listAvailableActions(chat).map((item) => item.id)).toEqual(expect.arrayContaining(["load_history", "send_messages", "close_phone"]));
  });

  it("enforces configured idle and sleep duration bounds", () => {
    const settings = defaultSettings("token");
    expect(() => validateDuration("idle", 29, settings)).toThrow(/30/);
    expect(() => validateDuration("idle", 480, settings)).not.toThrow();
    expect(() => validateDuration("sleep", 961, settings)).toThrow(/960/);
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

  it("uses the smaller of the absolute and model-relative archive boundaries", () => {
    expect(archiveThreshold(272_000, 1_000_000)).toBe(272_000);
    expect(archiveThreshold(272_000, 128_000)).toBe(102_400);
    expect(archiveThreshold(272_000, 100_000, 0.7)).toBe(70_000);
    expect(() => archiveThreshold(1, 1, 2)).toThrow(/比例/);
  });
});
