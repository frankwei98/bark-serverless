import { DurableObject } from "cloudflare:workers";
import { deviceStorageKey } from "@/services/device-registry-storage";

interface CoordinatorNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CoordinatorTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface CoordinatorStorage extends CoordinatorTransaction {
  transaction<T>(
    closure: (transaction: CoordinatorTransaction) => Promise<T>,
  ): Promise<T>;
}

interface CoordinatorEnv {
  DEVICE_REGISTRY: CoordinatorNamespace;
}

interface RegistrationState {
  deviceKey: string;
  token: string | null;
  generation?: number;
  lastMirrorAtMs?: number;
}

interface PendingMirror {
  generation: number;
  token: string | null;
  dueAtMs: number;
  failures: number;
}

interface CoordinatorClock {
  now(): number;
}

export interface DeviceRegistryCoordinatorStub {
  deviceTokenByKey(deviceKey: string): Promise<string | null>;
  saveDeviceTokenByKey(deviceKey: string, token: string): Promise<void>;
  deleteDeviceByKey(deviceKey: string, expectedToken?: string): Promise<boolean>;
}

const REGISTRATION_STATE_KEY = "registration";
const PENDING_MIRROR_KEY = "pendingMirror";
const KV_WRITE_INTERVAL_MS = 1_000;
const MAX_MIRROR_BACKOFF_MS = 60_000;

const systemClock: CoordinatorClock = {
  now: Date.now,
};

export class DeviceRegistryCoordinatorCore
  implements DeviceRegistryCoordinatorStub
{
  private operationTail: Promise<void> = Promise.resolve();
  private stateLoaded = false;
  private state: RegistrationState | undefined;

  constructor(
    private readonly storage: CoordinatorStorage,
    private readonly namespace: CoordinatorNamespace,
    private readonly clock: CoordinatorClock = systemClock,
  ) {}

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.operationTail;
    let release: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await preceding;
      try {
        return await operation();
      } finally {
        release!();
      }
    })();
  }

  private async readPersistedState(): Promise<RegistrationState | undefined> {
    if (!this.stateLoaded) {
      this.state = await this.storage.get<RegistrationState>(
        REGISTRATION_STATE_KEY,
      );
      this.stateLoaded = true;
    }
    return this.state;
  }

  private assertDeviceKey(state: RegistrationState, deviceKey: string): void {
    if (state.deviceKey !== deviceKey) {
      throw new Error("device registry coordinator key mismatch");
    }
  }

  private async legacyToken(deviceKey: string): Promise<string | null> {
    return this.namespace.get(deviceStorageKey(deviceKey));
  }

  private async nextMirrorTime(
    previous: RegistrationState | undefined,
  ): Promise<number> {
    const pending = await this.storage.get<PendingMirror>(PENDING_MIRROR_KEY);
    return Math.max(
      this.clock.now(),
      (previous?.lastMirrorAtMs ?? -KV_WRITE_INTERVAL_MS) +
        KV_WRITE_INTERVAL_MS,
      pending?.dueAtMs ?? 0,
    );
  }

  private async persistAuthoritativeState(
    state: RegistrationState,
  ): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      await transaction.put(REGISTRATION_STATE_KEY, state);
    });
    this.state = state;
    this.stateLoaded = true;
  }

  private async scheduleMirror(
    state: RegistrationState,
    pending: PendingMirror,
  ): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      await transaction.put(REGISTRATION_STATE_KEY, state);
      await transaction.put(PENDING_MIRROR_KEY, pending);
      await transaction.setAlarm(pending.dueAtMs);
    });
    this.state = state;
    this.stateLoaded = true;
  }

  private mirrorBackoff(failures: number): number {
    return Math.min(
      KV_WRITE_INTERVAL_MS * 2 ** Math.min(failures, 16),
      MAX_MIRROR_BACKOFF_MS,
    );
  }

  private async mirrorPendingIfDue(): Promise<void> {
    const pending = await this.storage.get<PendingMirror>(PENDING_MIRROR_KEY);
    if (pending === undefined) {
      return;
    }
    if (pending.dueAtMs > this.clock.now()) {
      await this.storage.setAlarm(pending.dueAtMs);
      return;
    }
    const registration = await this.readPersistedState();
    if (registration === undefined) {
      throw new Error("pending device registry mirror has no registration");
    }

    const attemptStartedAtMs = this.clock.now();
    const crashRetryAtMs = attemptStartedAtMs + MAX_MIRROR_BACKOFF_MS;
    const reservedState = await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingMirror>(PENDING_MIRROR_KEY);
      if (current?.generation !== pending.generation) {
        return undefined;
      }
      const currentRegistration = await transaction.get<RegistrationState>(
        REGISTRATION_STATE_KEY,
      );
      if (currentRegistration?.generation !== pending.generation) {
        return undefined;
      }
      const nextRegistration = {
        ...currentRegistration,
        lastMirrorAtMs: attemptStartedAtMs,
      };
      await transaction.put(REGISTRATION_STATE_KEY, nextRegistration);
      await transaction.put(PENDING_MIRROR_KEY, {
        ...current,
        dueAtMs: crashRetryAtMs,
      });
      await transaction.setAlarm(crashRetryAtMs);
      return nextRegistration;
    });
    if (reservedState === undefined) {
      return;
    }
    this.state = reservedState;

    let succeeded = false;
    try {
      if (pending.token === null) {
        await this.namespace.delete(deviceStorageKey(registration.deviceKey));
      } else {
        await this.namespace.put(
          deviceStorageKey(registration.deviceKey),
          pending.token,
        );
      }
      succeeded = true;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "device registry KV mirror failed",
          operation: pending.token === null ? "delete" : "put",
          generation: pending.generation,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    const completedAtMs = this.clock.now();
    const completedState = await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingMirror>(PENDING_MIRROR_KEY);
      if (current?.generation !== pending.generation) {
        return undefined;
      }
      const currentRegistration = await transaction.get<RegistrationState>(
        REGISTRATION_STATE_KEY,
      );
      let nextRegistration: RegistrationState | undefined;
      if (currentRegistration?.generation === pending.generation) {
        nextRegistration = {
          ...currentRegistration,
          lastMirrorAtMs: completedAtMs,
        };
        await transaction.put(REGISTRATION_STATE_KEY, nextRegistration);
      }
      if (succeeded) {
        await transaction.delete(PENDING_MIRROR_KEY);
        await transaction.deleteAlarm();
      } else {
        const failures = current.failures + 1;
        const retryAtMs = completedAtMs + this.mirrorBackoff(current.failures);
        await transaction.put(PENDING_MIRROR_KEY, {
          ...current,
          dueAtMs: retryAtMs,
          failures,
        });
        await transaction.setAlarm(retryAtMs);
      }
      return nextRegistration;
    });
    if (completedState !== undefined) {
      this.state = completedState;
    }
  }

  async deviceTokenByKey(deviceKey: string): Promise<string | null> {
    return this.runExclusive(async () => {
      const state = await this.readPersistedState();
      if (state === undefined) {
        return this.legacyToken(deviceKey);
      }

      this.assertDeviceKey(state, deviceKey);
      return state.token;
    });
  }

  async saveDeviceTokenByKey(deviceKey: string, token: string): Promise<void> {
    return this.runExclusive(async () => {
      const previous = await this.readPersistedState();
      if (previous !== undefined) {
        this.assertDeviceKey(previous, deviceKey);
      }

      const normalizedToken = token.length === 0 ? null : token;
      const currentToken =
        previous === undefined
          ? await this.legacyToken(deviceKey)
          : previous.token;
      if (currentToken === normalizedToken) {
        if (previous === undefined) {
          await this.persistAuthoritativeState({
            deviceKey,
            token: normalizedToken,
            generation: 0,
          });
        }
        return;
      }

      const generation = (previous?.generation ?? 0) + 1;
      const dueAtMs = await this.nextMirrorTime(previous);
      const next = {
        deviceKey,
        token: normalizedToken,
        generation,
        lastMirrorAtMs: previous?.lastMirrorAtMs,
      };
      await this.scheduleMirror(next, {
        generation,
        token: normalizedToken,
        dueAtMs,
        failures: 0,
      });
      await this.mirrorPendingIfDue();
    });
  }

  async deleteDeviceByKey(
    deviceKey: string,
    expectedToken?: string,
  ): Promise<boolean> {
    return this.runExclusive(async () => {
      const previous = await this.readPersistedState();
      if (previous !== undefined) {
        this.assertDeviceKey(previous, deviceKey);
      }

      const currentToken =
        previous === undefined
          ? await this.legacyToken(deviceKey)
          : previous.token;
      if (expectedToken !== undefined && currentToken !== expectedToken) {
        return false;
      }
      if (currentToken === null) {
        if (previous === undefined) {
          await this.persistAuthoritativeState({
            deviceKey,
            token: null,
            generation: 0,
          });
        }
        return true;
      }

      const generation = (previous?.generation ?? 0) + 1;
      const dueAtMs = await this.nextMirrorTime(previous);
      const next = {
        deviceKey,
        token: null,
        generation,
        lastMirrorAtMs: previous?.lastMirrorAtMs,
      };
      await this.scheduleMirror(next, {
        generation,
        token: null,
        dueAtMs,
        failures: 0,
      });
      await this.mirrorPendingIfDue();
      return true;
    });
  }

  alarm(): Promise<void> {
    return this.runExclusive(() => this.mirrorPendingIfDue());
  }
}

export class DeviceRegistryCoordinator extends DurableObject<CoordinatorEnv> {
  private readonly coordinator: DeviceRegistryCoordinatorCore;

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    super(ctx, env);
    this.coordinator = new DeviceRegistryCoordinatorCore(
      ctx.storage,
      env.DEVICE_REGISTRY,
    );
  }

  deviceTokenByKey(deviceKey: string): Promise<string | null> {
    return this.coordinator.deviceTokenByKey(deviceKey);
  }

  saveDeviceTokenByKey(deviceKey: string, token: string): Promise<void> {
    return this.coordinator.saveDeviceTokenByKey(deviceKey, token);
  }

  deleteDeviceByKey(
    deviceKey: string,
    expectedToken?: string,
  ): Promise<boolean> {
    return this.coordinator.deleteDeviceByKey(deviceKey, expectedToken);
  }

  alarm(): Promise<void> {
    return this.coordinator.alarm();
  }
}
