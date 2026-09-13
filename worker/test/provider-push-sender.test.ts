import { describe, expect, it, vi } from "vitest";
import { ProviderPushSender } from "@/services/provider-push-sender";
import { HuaweiPushError, HuaweiPushSender } from "@/services/huawei-push-sender";
import { buildPushMessage } from "@/routes/push";
import { createApnsError, createHarness, RecordingPushSender } from "./helpers/fakes";

function harness() {
  const test = createHarness({ registrySeed: { ios: "ios-token", shark: "harmony:shark-token" } });
  const huawei = new RecordingPushSender();
  test.deps.pushSender = new ProviderPushSender(test.sender, huawei);
  return { ...test, huawei };
}

describe("provider routing and public Bark API", () => {
  it("preserves the APNs message and does not require Huawei configuration", async () => {
    const apns = new RecordingPushSender();
    const router = new ProviderPushSender(apns, new HuaweiPushSender({}));
    const message = { ...buildPushMessage({ body: "Hello", sound: "bell" }), deviceToken: "ios-token" };
    await router.send(message);
    expect(apns.messages).toEqual([message]);
  });

  it("strips one prefix without mutating the shared message", async () => {
    const apns = new RecordingPushSender();
    const huawei = new RecordingPushSender();
    const message = Object.freeze({ ...buildPushMessage({ body: "Hi" }), deviceToken: "harmony:raw-token" });
    await new ProviderPushSender(apns, huawei).send(message);
    expect(huawei.messages[0].deviceToken).toBe("raw-token");
    expect(message.deviceToken).toBe("harmony:raw-token");
    expect(apns.messages).toHaveLength(0);
  });

  it.each(["harmony:", "harmony:harmony:token"])("rejects malformed stored token %s", async (deviceToken) => {
    const apns = new RecordingPushSender();
    const huawei = new RecordingPushSender();
    await expect(new ProviderPushSender(apns, huawei).send({
      ...buildPushMessage({ body: "Hi" }), deviceToken,
    })).rejects.toThrow("Huawei device token is invalid");
    expect(huawei.messages).toHaveLength(0);
    expect(apns.messages).toHaveLength(0);
  });

  it("registers Shark then sends through the existing V1 path", async () => {
    const { app, huawei, registry } = harness();
    const registration = await app.request("http://example.com/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_key: "fresh", device_token: "new-token", platform: "hmos" }),
    });
    expect(registration.status).toBe(200);
    expect(registry.snapshot().fresh).toBe("harmony:new-token");
    const pushed = await app.request("http://example.com/fresh/Title/Body?sound=bell");
    expect(pushed.status).toBe(200);
    expect(huawei.messages[0]).toMatchObject({ deviceToken: "new-token", title: "Title", body: "Body", rawSound: "bell" });
  });

  it("keeps mixed batch results ordered and isolates provider errors", async () => {
    const { app, huawei, sender, registry } = harness();
    huawei.failForDeviceToken("shark-token", new HuaweiPushError("Huawei push failed with business code 80300007", 200, "80300007"));
    const response = await app.request("http://example.com/push", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_keys: ["ios", "shark", "ios"], body: "Hi" }),
    });
    const json = await response.json() as { data: { code: number; device_key: string }[] };
    expect(json.data.map((row: { code: number; device_key: string }) => [row.device_key, row.code]))
      .toEqual([["ios", 200], ["shark", 500], ["ios", 200]]);
    expect(sender.messages).toHaveLength(2);
    expect(registry.snapshot().shark).toBe("harmony:shark-token");
  });

  it("does not apply APNs cleanup or expose unexpected Huawei errors", async () => {
    const { app, huawei, registry } = harness();
    huawei.failForDeviceToken("shark-token", createApnsError("BadDeviceToken sensitive-diagnostic", 410));
    const remove = vi.spyOn(registry, "deleteDeviceByKey");
    const response = await app.request("http://example.com/shark/hello");
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ message: "push failed: Huawei push failed" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("preserves a Harmony replacement when an older APNs request is rejected", async () => {
    const { app, sender, registry } = harness();
    sender.send = async () => {
      await registry.saveDeviceTokenByKey("ios", "harmony:new-token");
      throw createApnsError("BadDeviceToken", 400);
    };
    const remove = vi.spyOn(registry, "deleteDeviceByKey");
    expect((await app.request("http://example.com/ios/hello")).status).toBe(500);
    expect(remove).toHaveBeenCalledWith("ios", "ios-token");
    expect(registry.snapshot().ios).toBe("harmony:new-token");
  });

  it("routes MCP notify through Huawei with the path device key", async () => {
    const { app, huawei } = harness();
    const response = await app.request("http://example.com/mcp/shark", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "notify", arguments: { title: "Hello", body: "World", device_key: "ios" },
      } }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { isError?: boolean } };
    expect(body.result.isError).not.toBe(true);
    expect(huawei.messages[0]).toMatchObject({ deviceKey: "shark", deviceToken: "shark-token" });
  });
});
