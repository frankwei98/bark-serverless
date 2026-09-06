// Created at the registry boundary after a successful lookup, never from an RPC failure.
export class DeviceLookupError extends Error {
  constructor(message: "key not found" | "device token invalid") {
    super(message);
    this.name = "DeviceLookupError";
  }
}
